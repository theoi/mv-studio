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
/** Most passage lengths tried from one word, which bounds the time spent on songs that chant one word for long. */
const LENGTHS_TRIED = 24
/** A pause (seconds) that cuts a few first or last matching words off an occurrence. */
const EDGE_PAUSE = 2.5
/** An occurrence lasts at most this times the median occurrence, so a late last line does not stretch it. */
const MAX_STRETCH = 1.25
/** A lyric chorus outside the detected chorus takes over a section it covers at least this much of. */
const COVERS_SECTION = 0.6
/** Fewest words sung in a passage before the lyrics can say what it is; fewer is instrumental. */
const MIN_SUNG_WORDS = 6
/** How much the lyrics may extend a detected chorus they repeat in, as a share of its length. */
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
 * song (occurrences times words). Passages match word by word, tolerating up to two changed, added or dropped words
 * in a row, so line breaks do not matter and lyrics broken differently from one chorus to the next still match.
 * Null when nothing of six words or more is sung twice.
 */
export function findLyricChorus(lines: readonly LyricLine[]): LyricChorus | null {
  const words = sungWords(lines)
  const keys = words.map((w) => w.key)
  const n = keys.length
  // run[i * n + j]: words from i that match the words from j, in order, with small differences. After a difference
  // the match picks up again only on two words in a row, so verses sharing a few common words do not match.
  const run = new Uint16Array(n * n)
  for (let i = n - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--) {
      if (i === j || keys[i] !== keys[j]) continue
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
  const repeated = new Uint8Array(n)
  let best = { score: 0, starts: [] as number[], length: 0 }
  for (let i = 0; i < n; i++) {
    const partners: number[] = []
    for (let j = 0; j < n; j++) if (run[i * n + j]! >= MIN_PASSAGE_WORDS) partners.push(j)
    if (!partners.length) continue
    const lengths = [...new Set(partners.map((j) => run[i * n + j]!))].sort((a, b) => a - b)
    repeated.fill(1, i, i + lengths.at(-1)!)
    // Passage lengths to try: where the set of matching partners changes, at most LENGTHS_TRIED of them, so songs
    // that chant one word for minutes stay quick.
    const step = Math.max(1, lengths.length / LENGTHS_TRIED)
    for (let t = 0; t < lengths.length; t += step) {
      const k = lengths[Math.floor(t)]!
      const starts = [i]
      let last = -Infinity
      for (const j of partners) {
        if (run[i * n + j]! < k || Math.abs(j - i) < k || j - last < k) continue
        starts.push(j)
        last = j
      }
      if (starts.length < 2) continue
      const score = starts.length * k
      if (score > best.score) best = { score, starts: starts.sort((x, y) => x - y), length: k }
    }
  }
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
 * - A lyric chorus elsewhere takes over the sections it covers most of, and otherwise runs on to the edges of the
 *   sections it starts and ends in, unless a verse is sung there: a chorus lasts longer than its repeated lines.
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
        ranges.push({ start: s.start, end: s.end, confidence: s.confidence })
      continue
    }
    hits.forEach((r) => used.add(r))
    const reach = MAX_EXTENSION * (s.end - s.start)
    ranges.push({
      start: Math.min(s.start, Math.max(s.start - reach, Math.min(...hits.map((r) => r.start)))),
      end: Math.max(s.end, Math.min(s.end + reach, Math.max(...hits.map((r) => r.end)))),
      confidence: LYRIC_CHORUS_CONFIDENCE,
    })
  }
  const at = (t: number) => sections.find((s) => t >= s.start && t < s.end && isDetected(s))
  for (const r of chorus.ranges) {
    if (used.has(r)) continue
    const covered = sections.filter(
      (s) => isDetected(s) && overlap(r, s) >= COVERS_SECTION * (s.end - s.start),
    )
    let start = Math.min(r.start, ...covered.map((s) => s.start))
    let end = Math.max(r.end, ...covered.map((s) => s.end))
    const head = at(start)
    const tail = at(end - 1e-3)
    if (head && head.start < start && !verse({ start: head.start, end: start })) start = head.start
    if (tail && tail.end > end && !verse({ start: end, end: tail.end })) end = tail.end
    ranges.push({ start, end, confidence: LYRIC_CHORUS_CONFIDENCE })
  }
  return ranges.sort((a, b) => a.start - b.start)
}

/**
 * The sections with `chorus` as their choruses: sections are cut at the chorus edges (moved to the nearest of
 * `grid`, downbeats or else beats, within 2 s), the pieces inside become one repeat group labeled chorus with the
 * range's confidence (default `confidence`), and detected choruses outside become verses. Labels the user entered
 * (any label with confidence 1, or one the analysis never assigns) are kept. Neighbours with the same label merge, as
 * in the section analysis. The chorus keeps the repeat group it mostly came from when no section outside it shares
 * that group.
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
  const cut: { piece: SongSection; range: ChorusRange | undefined }[] = []
  for (const s of sections) {
    const cuts = [
      s.start,
      ...ranges.flatMap((r) => [r.start, r.end]).filter((t) => t > s.start && t < s.end),
      s.end,
    ]
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || t > all[i - 1]!)
    for (let k = 0; k + 1 < cuts.length; k++) {
      const piece: SongSection = {
        ...s,
        id: k === 0 ? s.id : `${s.id}.${k}`,
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
  const pieces: SongSection[] = []
  for (const { piece, range } of cut) {
    if (range) {
      piece.label = 'chorus'
      piece.repeatGroup = group
      piece.confidence = range.confidence
    } else if (piece.label === 'chorus' && isDetected(piece)) {
      piece.label = 'verse'
      delete piece.confidence
    }
    const last = pieces.at(-1)
    const sameKind =
      last?.label === piece.label &&
      last.confidence === piece.confidence &&
      (last.repeatGroup === piece.repeatGroup || piece.label !== 'chorus')
    if (last && (piece.end - piece.start < 1 || sameKind)) last.end = piece.end
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
