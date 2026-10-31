import type { AudioAnalysis, EditCommand, LyricLine, LyricsDoc, SongSection } from '../../model/index.ts'
import { alignmentKey } from '../lyrics/text.ts'

export interface TimeRange {
  start: number
  end: number
}

/** A chorus range, with the `SongSection.confidence` its sections get when it differs from the default. */
export interface ChorusRange extends TimeRange {
  confidence?: number
}

/** Changed, added or dropped words in a row that two passages may differ by and still match. */
const BRIDGE = 2
/** Fewest words in a repeated passage; shorter repeats are hooks or fillers, not a chorus. */
const MIN_PASSAGE_WORDS = 6
/** Most passage lengths tried from one word. */
const LENGTHS_TRIED = 24
/**
 * Bounds that keep the search well under 50 ms on the main thread when a song chants a few words hundreds of times.
 * Lyrics stay far below both: the dev songs reach 12,000 pairs (528 words) and 42,000 steps. Over MAX_PAIRS (the sum
 * of each word's count squared), the most frequent words match nothing; over MAX_WORK (partners times passage lengths
 * tried, summed over starts), fewer lengths are tried from each start.
 */
const MAX_PAIRS = 100_000
const MAX_WORK = 200_000
/**
 * Occurrences with at least this many other words between them, or a pause this long (an instrumental stretch),
 * recur in different places of the song; otherwise they are sung back to back in one place.
 */
const SEPARATION_WORDS = 3
const SEPARATION_SECONDS = 4
/** What a back-to-back repeat adds to a passage's score, against 1 for each place in the song it recurs in. */
const ADJACENT_WEIGHT = 0.25
/** A pause (seconds) that cuts a few first or last matching words off an occurrence. */
const EDGE_PAUSE = 2.5
/** An occurrence lasts at most this times the median occurrence, so a late last line does not stretch it. */
const MAX_STRETCH = 1.25
/** A lyric chorus outside the detected chorus takes over a section it covers at least this much of. */
const COVERS_SECTION = 0.6
/** Fewest words sung in a passage before the lyrics can say what it is; fewer is instrumental. */
const MIN_SUNG_WORDS = 6
/** How much the lyrics may extend a detected chorus they repeat in, at both ends together, as a share of its length. */
const MAX_EXTENSION = 0.25
/** How far a chorus edge may move to reach a downbeat (or a beat when bars are not found), in seconds. */
const SNAP = 2
/** Labels the section analysis assigns; any other label was entered by the user and is kept. */
const DETECTED = new Set(['intro', 'verse', 'chorus', 'bridge', 'outro'])
/** `SongSection.confidence` of a chorus found from the audio alone. A label the user typed has confidence 1. */
export const AUDIO_CHORUS_CONFIDENCE = 0.4
/** `SongSection.confidence` of a chorus found from repeated lyrics. */
export const LYRIC_CHORUS_CONFIDENCE = 0.8
/** `SongSection.confidence` of an audio chorus that drafted (transcribed) lyrics repeat as well. */
export const DRAFT_CONFIRMED_CHORUS_CONFIDENCE = 0.6

interface SungWord extends TimeRange {
  key: string
}

/** The lyrics' chorus: the time range of each occurrence, and every sung word with whether it is sung elsewhere too. */
export interface LyricChorus {
  ranges: TimeRange[]
  words: (TimeRange & { repeated: boolean })[]
}

/** Timed words in singing order; a line without word times spreads its words evenly over its time. */
function sungWords(lines: readonly LyricLine[]): SungWord[] {
  const out: SungWord[] = []
  for (const line of lines) {
    if (line.start === undefined || line.end === undefined) continue
    const timed = line.words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    if (timed.length) {
      for (const w of timed) out.push({ key: alignmentKey(w.text), start: w.start, end: w.end })
      continue
    }
    const texts = line.text.split(/\s+/).filter(Boolean)
    const step = (line.end - line.start) / Math.max(1, texts.length)
    texts.forEach((text, i) =>
      out.push({ key: alignmentKey(text), start: line.start! + i * step, end: line.start! + (i + 1) * step }),
    )
  }
  return out.filter((w) => w.key.length > 0)
}

const isDetected = (s: SongSection) => DETECTED.has(s.label) && s.confidence !== 1
const overlap = (a: TimeRange, b: TimeRange) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/**
 * The chorus from timed lyrics: the passage of at least six words that, sung again and again, covers the most of the
 * song (words times the places it recurs in, separated by other material; back-to-back repeats count a little).
 * Passages match word by word, tolerating up to two changed, added or dropped words in a row, so line breaks do not
 * matter and lyrics broken differently from one chorus to the next still match.
 * Null when nothing of six words or more is sung twice.
 */
export function findLyricChorus(lines: readonly LyricLine[]): LyricChorus | null {
  const words = sungWords(lines)
  const n = words.length
  // Where each word is sung, most frequent first. Words dropped to stay within MAX_PAIRS get an id of their own.
  const at = new Map<string, number[]>()
  words.forEach((w, i) => (at.get(w.key) ?? at.set(w.key, []).get(w.key)!).push(i))
  const groups = [...at.values()].sort((a, b) => b.length - a.length)
  let pairs = groups.reduce((sum, g) => sum + g.length ** 2, 0)
  while (pairs > MAX_PAIRS) pairs -= groups.shift()!.length ** 2
  const keys = Int32Array.from(words, (_, i) => -1 - i)
  groups.forEach((g, id) => g.forEach((i) => (keys[i] = id)))
  // run[i * n + j]: words from i that match the words from j, in order, with small differences. After a difference
  // the match picks up again only on two words in a row, so verses sharing a few common words do not match. Only
  // equal words are compared.
  const run = new Uint16Array(n * n)
  for (let i = n - 1; i >= 0; i--) {
    if (keys[i]! < 0) continue
    for (const j of groups[keys[i]!]!) {
      if (j === i) continue
      let best = 1
      for (let a = 1; a <= BRIDGE + 1; a++)
        for (let b = Math.max(1, a - 1); b <= Math.min(BRIDGE + 1, a + 1); b++) {
          if (i + a >= n || j + b >= n) continue
          const next = run[(i + a) * n + j + b]!
          if (!next || ((a > 1 || b > 1) && (next < 2 || keys[i + a + 1] !== keys[j + b + 1]))) continue
          best = Math.max(best, a + next)
        }
      run[i * n + j] = best
    }
  }
  // Words sung again elsewhere, as part of a passage of six words or more.
  const repeated = new Uint8Array(n)
  const partnersOf: number[][] = []
  for (let i = 0; i < n; i++) {
    const partners: number[] = []
    let longest = 0
    for (const j of keys[i]! < 0 ? [] : groups[keys[i]!]!)
      if (run[i * n + j]! >= MIN_PASSAGE_WORDS) {
        partners.push(j)
        longest = Math.max(longest, run[i * n + j]!)
      }
    partnersOf.push(partners)
    repeated.fill(1, i, i + longest)
  }
  // Other material between two matches of a k-word passage, so they recur in different places rather than back to
  // back: a pause as long as an instrumental stretch, or a few words that are neither the words just before them again
  // (a tag sung twice) nor part of a loop that repeats the passage and those words over and over. Overlapping matches
  // (a passage inside a loop) are in one place.
  const apart = (prev: number, next: number, k: number) => {
    const end = prev + k - 1
    for (let w = end; w < next; w++)
      if (words[w + 1]!.start - words[w]!.end >= SEPARATION_SECONDS) return true
    const gap = next - end - 1
    if (gap < SEPARATION_WORDS) return false
    const between = end + 1
    const period = next - prev
    const sungAt = (from: number) => from >= 0 && from < n && run[from * n + between]! >= gap
    return !sungAt(between - gap) && !sungAt(between - period) && !sungAt(between + period)
  }
  // The best passage recurring in two places or more; one sung only back to back in one place counts only when no
  // passage recurs (a song whose one repeat is a stanza sung twice).
  // Starts to try, with the passage lengths where their set of matching partners changes.
  const candidates: { i: number; lengths: number[] }[] = []
  let work = 0
  for (let i = 0; i < n; i++) {
    const partners = partnersOf[i]!
    if (!partners.length) continue
    const lengths = [...new Set(partners.map((j) => run[i * n + j]!))].sort((a, b) => a - b)
    candidates.push({ i, lengths })
    work += partners.length * Math.min(lengths.length, LENGTHS_TRIED)
  }
  const share = Math.min(1, MAX_WORK / work)
  let best = { score: 0, starts: [] as number[], length: 0 }
  let single = best
  for (const { i, lengths } of candidates) {
    const partners = partnersOf[i]!
    const step = lengths.length / Math.max(1, Math.round(Math.min(lengths.length, LENGTHS_TRIED) * share))
    for (let t = 0; t < lengths.length; t += step) {
      const k = lengths[Math.floor(t)]!
      // Partners are in singing order, so both lists are too with i put in its place.
      const starts: number[] = []
      const matches: number[] = []
      let placed = false
      let last = -Infinity
      for (const j of partners) {
        if (run[i * n + j]! < k) continue
        if (!placed && j > i) {
          starts.push(i)
          matches.push(i)
          placed = true
        }
        matches.push(j)
        if (Math.abs(j - i) < k || j - last < k) continue
        starts.push(j)
        last = j
      }
      if (!placed) {
        starts.push(i)
        matches.push(i)
      }
      if (starts.length < 2) continue
      // A chorus recurs across the song with other material between; a couplet sung four times in one place does
      // not. Each place counts fully, repeats within a place a little.
      let places = 1
      for (let q = 1; q < matches.length; q++) if (apart(matches[q - 1]!, matches[q]!, k)) places++
      const score = k * (places + ADJACENT_WEIGHT * (starts.length - places))
      if (places >= 2 && score > best.score) best = { score, starts, length: k }
      else if (places === 1 && score > single.score) single = { score, starts, length: k }
    }
  }
  if (!best.starts.length) best = single
  if (!best.starts.length) return null
  const ranges = best.starts.map((s) => {
    let first = s
    let last = Math.min(n - 1, s + best.length - 1)
    // A few words cut off by a pause only match because the lines before (or after) both occurrences end (or start)
    // alike; they are not part of the chorus.
    const pause = (k: number) => words[k + 1]!.start - words[k]!.end > EDGE_PAUSE
    const edge = MIN_PASSAGE_WORDS - 1
    for (let k = Math.min(last - 1, first + edge - 1); k >= first; k--)
      if (pause(k)) {
        first = k + 1
        break
      }
    for (let k = Math.max(first, last - edge); k < last; k++)
      if (pause(k)) {
        last = k
        break
      }
    return { start: words[first]!.start, end: words[last]!.end }
  })
  const durations = ranges.map((r) => r.end - r.start).sort((a, b) => a - b)
  const longest = MAX_STRETCH * durations[(durations.length - 1) >> 1]!
  return {
    ranges: ranges.map((r) => ({ start: r.start, end: Math.min(r.end, r.start + longest) })),
    words: words.map((w, i) => ({ start: w.start, end: w.end, repeated: repeated[i] === 1 })),
  }
}

/**
 * The chorus ranges once the lyrics' chorus is combined with the detected one, so pasted lyrics correct the detected
 * chorus without overriding a good one:
 * - A detected chorus the lyrics repeat in is confirmed and never shrinks. The lyrics extend it by at most a quarter
 *   of its length (a longer occurrence also spans a neighbouring part that repeats with it).
 * - A detected chorus the lyrics do not repeat in stays only where mostly repeated words are sung: an instrumental
 *   passage or a verse is not the chorus when the lyrics show where it is.
 * - A lyric chorus elsewhere takes over the sections it covers most of.
 * Ranges the lyrics confirm or add get `LYRIC_CHORUS_CONFIDENCE`.
 */
export function lyricChorusRanges(sections: readonly SongSection[], chorus: LyricChorus): ChorusRange[] {
  const sungIn = (range: TimeRange) =>
    chorus.words.filter((w) => (w.start + w.end) / 2 >= range.start && (w.start + w.end) / 2 < range.end)
  const verse = (range: TimeRange) => {
    const sung = sungIn(range)
    return sung.length >= MIN_SUNG_WORDS && sung.filter((w) => !w.repeated).length > sung.length / 2
  }
  const ranges: ChorusRange[] = []
  const used = new Set<TimeRange>()
  for (const s of sections) {
    if (s.label !== 'chorus' || !isDetected(s)) continue
    const hits = chorus.ranges.filter((r) => overlap(r, s) >= Math.min(1, (r.end - r.start) / 2))
    if (!hits.length) {
      if (sungIn(s).length >= MIN_SUNG_WORDS && !verse(s))
        ranges.push({ start: s.start, end: s.end, confidence: s.confidence ?? AUDIO_CHORUS_CONFIDENCE })
      continue
    }
    hits.forEach((r) => used.add(r))
    const before = Math.max(0, s.start - Math.min(...hits.map((r) => r.start)))
    const after = Math.max(0, Math.max(...hits.map((r) => r.end)) - s.end)
    const scale = Math.min(1, (MAX_EXTENSION * (s.end - s.start)) / (before + after || 1))
    ranges.push({
      start: s.start - before * scale,
      end: s.end + after * scale,
      confidence: LYRIC_CHORUS_CONFIDENCE,
    })
  }
  for (const r of chorus.ranges) {
    if (used.has(r)) continue
    const covered = sections.filter(
      (s) => isDetected(s) && overlap(r, s) >= COVERS_SECTION * (s.end - s.start),
    )
    ranges.push({
      start: Math.min(r.start, ...covered.map((s) => s.start)),
      end: Math.max(r.end, ...covered.map((s) => s.end)),
      confidence: LYRIC_CHORUS_CONFIDENCE,
    })
  }
  return ranges.sort((a, b) => a.start - b.start)
}

/**
 * The sections with `chorus` as their choruses: sections are cut at the chorus edges (moved to the nearest of
 * `grid`, downbeats or else beats, within 2 s), the pieces inside become one repeat group labeled chorus with the
 * range's confidence (default `confidence`), and detected choruses outside become verses. Sections the user named
 * (any label with confidence 1, or one the analysis never assigns) stay as they are: never cut, merged or relabeled.
 * Neighbours with the same label merge, as in the section analysis, and a piece shorter than a second joins a
 * detected neighbour. New pieces get ids no other section has. The chorus keeps the repeat group it mostly came from
 * when no section outside it shares that group.
 */
export function withChorus(
  sections: readonly SongSection[],
  chorus: readonly ChorusRange[],
  grid: readonly number[],
  confidence: number,
): SongSection[] {
  const snap = (t: number) => {
    let best = t
    let distance = SNAP
    for (const d of grid) {
      if (Math.abs(d - t) > distance) continue
      best = d
      distance = Math.abs(d - t)
    }
    return best
  }
  const ranges = chorus
    .map((r) => ({ start: snap(r.start), end: snap(r.end), confidence: r.confidence ?? confidence }))
    .filter((r) => r.end > r.start)
  const rangeAt = (t: number) => ranges.find((r) => t >= r.start && t < r.end)
  const ids = new Set(sections.map((s) => s.id))
  const pieceId = (id: string) => {
    let k = 1
    while (ids.has(`${id}.${k}`)) k++
    ids.add(`${id}.${k}`)
    return `${id}.${k}`
  }
  const cut: { piece: SongSection; range: ChorusRange | undefined }[] = []
  for (const s of sections) {
    const edges = isDetected(s) ? ranges.flatMap((r) => [r.start, r.end]) : []
    const cuts = [s.start, ...edges.filter((t) => t > s.start && t < s.end), s.end]
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || t > all[i - 1]!)
    for (let k = 0; k + 1 < cuts.length; k++) {
      const piece: SongSection = {
        ...s,
        id: k === 0 ? s.id : pieceId(s.id),
        start: cuts[k]!,
        end: cuts[k + 1]!,
      }
      cut.push({ piece, range: isDetected(s) ? rangeAt((piece.start + piece.end) / 2) : undefined })
    }
  }
  const weight = new Map<number, number>()
  for (const { piece, range } of cut)
    if (range && piece.repeatGroup !== undefined)
      weight.set(piece.repeatGroup, (weight.get(piece.repeatGroup) ?? 0) + piece.end - piece.start)
  const main = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0]
  const group =
    main !== undefined &&
    !cut.some(({ piece, range }) => !range && piece.repeatGroup === main && piece.end - piece.start >= 1)
      ? main
      : Math.max(-1, ...sections.map((s) => s.repeatGroup ?? -1)) + 1
  for (const { piece, range } of cut) {
    if (range) {
      piece.label = 'chorus'
      piece.repeatGroup = group
      piece.confidence = range.confidence
    } else if (piece.label === 'chorus' && isDetected(piece)) {
      piece.label = 'verse'
      delete piece.confidence
    }
  }
  const pieces: SongSection[] = []
  for (const [i, { piece }] of cut.entries()) {
    const last = pieces.at(-1)
    const next = cut[i + 1]?.piece
    const short = piece.end - piece.start < 1
    const sameKind =
      last?.label === piece.label &&
      last.confidence === piece.confidence &&
      (last.repeatGroup === piece.repeatGroup || piece.label !== 'chorus')
    if (last && isDetected(last) && isDetected(piece) && (short || sameKind)) last.end = piece.end
    else if (short && next && isDetected(next) && isDetected(piece)) next.start = piece.start
    else pieces.push(piece)
  }
  return pieces
}

/**
 * The edit that relabels the song's sections with the lyrics' chorus (`lyricChorusRanges`). Lyrics that are not
 * pasted (drafts, edited or not) do not move the chorus: they mishear too many words, so their repeated passages come
 * out short and partial. When their chorus mostly lies inside the detected chorus they confirm it instead, raising
 * its confidence. Chorus edges go to downbeats, or to beats while bars are not found. Null when there is nothing to
 * change. A background result: dispatch with `{ history: 'skip' }`; it applies only if the sections are still the
 * ones it was computed from.
 */
export function lyricChorusCommand(analysis: AudioAnalysis, lyrics: LyricsDoc): EditCommand | null {
  const sections = analysis.sections
  if (!sections?.length) return null
  const chorus = findLyricChorus(lyrics.lines)
  if (!chorus) return null
  const grid = analysis.downbeats?.length ? analysis.downbeats : (analysis.beats ?? [])
  const refined =
    lyrics.source === 'pasted'
      ? withChorus(sections, lyricChorusRanges(sections, chorus), grid, LYRIC_CHORUS_CONFIDENCE)
      : confirmed(sections, chorus.ranges)
  if (!refined) return null
  return {
    type: 'analysis.setRefined',
    assetId: analysis.assetId,
    refined: { sections: refined },
    baseline: { sections },
  }
}

/** The sections with their detected chorus confirmed, or null when `chorus` mostly lies outside it. */
function confirmed(sections: readonly SongSection[], chorus: readonly TimeRange[]): SongSection[] | null {
  const unsure = (s: SongSection) =>
    s.label === 'chorus' && (s.confidence ?? 0) < DRAFT_CONFIRMED_CHORUS_CONFIDENCE
  let inside = 0
  let total = 0
  for (const r of chorus) {
    total += r.end - r.start
    for (const s of sections) if (unsure(s)) inside += overlap(r, s)
  }
  if (inside <= total / 2) return null
  return sections.map((s) => (unsure(s) ? { ...s, confidence: DRAFT_CONFIRMED_CHORUS_CONFIDENCE } : s))
}

/**
 * The edit that moves the edges of the lyrics' chorus (sections labeled chorus with `LYRIC_CHORUS_CONFIDENCE`) to the
 * nearest downbeat within 2 s, for bars found after the chorus was set on beats. Each edge moves with the section
 * next to it, and never so far that a section gets shorter than a second. Null without bars or when nothing moves. A
 * background result: dispatch with `{ history: 'skip' }`.
 */
export function chorusEdgesCommand(analysis: AudioAnalysis): EditCommand | null {
  const sections = analysis.sections
  const downbeats = analysis.downbeats ?? []
  if (!sections?.length || !downbeats.length) return null
  const lyric = (s: SongSection) => s.label === 'chorus' && s.confidence === LYRIC_CHORUS_CONFIDENCE
  const next = sections.map((s) => ({ ...s }))
  let moved = false
  for (let i = 0; i + 1 < next.length; i++) {
    const [a, b] = [next[i]!, next[i + 1]!]
    if (lyric(a) === lyric(b) || Math.abs(a.end - b.start) > 1e-6) continue
    let edge = a.end
    let distance = Infinity
    for (const d of downbeats) {
      const gap = Math.abs(d - a.end)
      if (gap > SNAP || gap >= distance) continue
      edge = d
      distance = gap
    }
    if (edge === a.end || edge < a.start + 1 || edge > b.end - 1) continue
    a.end = edge
    b.start = edge
    moved = true
  }
  if (!moved) return null
  return {
    type: 'analysis.setRefined',
    assetId: analysis.assetId,
    refined: { sections: next },
    baseline: { sections },
  }
}
