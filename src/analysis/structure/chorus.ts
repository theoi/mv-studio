import type { AudioAnalysis, EditCommand, LyricLine, LyricsDoc, SongSection } from '../../model/index.ts'
import { alignmentKey } from '../lyrics/text.ts'

export interface TimeRange {
  start: number
  end: number
}

/** Lines whose word sets overlap more than this (Jaccard) are the same line, so small differences still match. */
const SAME_LINE = 0.8
/** An occurrence lasts at most this times the median occurrence, so a late last line does not stretch it. */
const MAX_STRETCH = 1.25
/** How far a chorus edge may move to reach a downbeat, in seconds. */
const SNAP = 2
/** Labels the section analysis assigns; any other label was entered by the user and is kept. */
const DETECTED = new Set(['intro', 'verse', 'chorus', 'bridge', 'outro'])
/** `SongSection.confidence` of a chorus found from the audio alone. A label the user typed has confidence 1. */
export const AUDIO_CHORUS_CONFIDENCE = 0.4
/** `SongSection.confidence` of a chorus found from repeated lyric lines. */
export const LYRIC_CHORUS_CONFIDENCE = 0.8
/** `SongSection.confidence` of an audio chorus that drafted (transcribed) lyrics repeat as well. */
export const DRAFT_CONFIRMED_CHORUS_CONFIDENCE = 0.6

/**
 * The chorus from timed lyrics: the repeated run of at least two lines that covers the most of the song
 * (occurrences times words). Choruses repeat their words, verses mostly only their music. Returns the time range of
 * each occurrence, or null when no run of two lines repeats.
 */
export function findLyricChorus(lines: readonly LyricLine[]): TimeRange[] | null {
  const timed = lines.filter((l) => l.start !== undefined && l.end !== undefined)
  const words = timed.map((l) => l.text.split(/\s+/).map(alignmentKey).filter(Boolean))
  const sets = words.map((w) => new Set(w))
  const n = timed.length
  // run[i][j]: how many lines in a row starting at i and at j are the same.
  const run = Array.from({ length: n + 1 }, () => new Uint16Array(n + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      run[i]![j] = i !== j && sameLine(sets[i]!, sets[j]!) ? run[i + 1]![j + 1]! + 1 : 0
  let best = { score: 0, starts: [] as number[], length: 0 }
  for (let i = 0; i < n; i++) {
    let blockWords = words[i]!.length
    for (let k = 2; i + k <= n; k++) {
      blockWords += words[i + k - 1]!.length
      const starts = [i]
      for (let j = 0; j < n; j++)
        if (run[i]![j]! >= k && starts.every((s) => Math.abs(s - j) >= k)) starts.push(j)
      if (starts.length < 2) break
      const score = starts.length * blockWords
      if (score > best.score) best = { score, starts: starts.sort((a, b) => a - b), length: k }
    }
  }
  if (best.starts.length === 0) return null
  const ranges = best.starts.map((s) => ({
    start: timed[s]!.start ?? 0,
    end: timed[s + best.length - 1]!.end ?? 0,
  }))
  const durations = ranges.map((r) => r.end - r.start).sort((a, b) => a - b)
  const longest = MAX_STRETCH * durations[(durations.length - 1) >> 1]!
  return ranges.map((r) => ({ start: r.start, end: Math.min(r.end, r.start + longest) }))
}

function sameLine(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared) > SAME_LINE
}

/**
 * The sections with `chorus` as their choruses: sections are cut at the chorus edges (moved to the nearest downbeat
 * within 2 s), the pieces inside become one repeat group labeled chorus with `confidence`, and detected choruses
 * outside become verses. Labels the user entered (any label with confidence 1, or one the analysis never assigns) are
 * kept. Neighbours with the same label merge, as in the section analysis. The chorus keeps the repeat group it mostly
 * came from when no section outside it shares that group.
 */
export function withChorus(
  sections: readonly SongSection[],
  chorus: readonly TimeRange[],
  downbeats: readonly number[],
  confidence: number,
): SongSection[] {
  const detected = (s: SongSection) => DETECTED.has(s.label) && s.confidence !== 1
  const snap = (t: number) => {
    let best = t
    let distance = SNAP
    for (const d of downbeats) {
      if (Math.abs(d - t) > distance) continue
      best = d
      distance = Math.abs(d - t)
    }
    return best
  }
  const ranges = chorus
    .map((r) => ({ start: snap(r.start), end: snap(r.end) }))
    .filter((r) => r.end > r.start)
  const inChorus = (t: number) => ranges.some((r) => t >= r.start && t < r.end)
  const cut: { piece: SongSection; inside: boolean }[] = []
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
      cut.push({ piece, inside: detected(s) && inChorus((piece.start + piece.end) / 2) })
    }
  }
  const weight = new Map<number, number>()
  for (const { piece, inside } of cut)
    if (inside && piece.repeatGroup !== undefined)
      weight.set(piece.repeatGroup, (weight.get(piece.repeatGroup) ?? 0) + piece.end - piece.start)
  const main = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0]
  const group =
    main !== undefined &&
    !cut.some(({ piece, inside }) => !inside && piece.repeatGroup === main && piece.end - piece.start >= 1)
      ? main
      : Math.max(-1, ...sections.map((s) => s.repeatGroup ?? -1)) + 1
  const pieces: SongSection[] = []
  for (const { piece, inside } of cut) {
    if (inside) {
      piece.label = 'chorus'
      piece.repeatGroup = group
      piece.confidence = confidence
    } else if (piece.label === 'chorus' && detected(piece)) {
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
 * The edit that relabels the song's sections so the lyrics' chorus is the chorus. Lyrics that are not pasted (drafts,
 * edited or not) do not move the chorus: they mishear too many words, so their repeated runs come out short and
 * partial. When their chorus mostly lies inside the detected chorus they confirm it instead, raising its confidence.
 * Null when there is nothing to change. A background result: dispatch with \`{ history: 'skip' }\`; it applies only if
 * the sections are still the ones it was computed from.
 */
export function lyricChorusCommand(analysis: AudioAnalysis, lyrics: LyricsDoc): EditCommand | null {
  const chorus = findLyricChorus(lyrics.lines)
  const sections = analysis.sections
  if (!chorus || !sections?.length) return null
  const refined =
    lyrics.source === 'pasted'
      ? withChorus(sections, chorus, analysis.downbeats ?? [], LYRIC_CHORUS_CONFIDENCE)
      : confirmed(sections, chorus)
  if (!refined) return null
  return {
    type: 'analysis.setRefined',
    assetId: analysis.assetId,
    refined: { sections: refined },
    baseline: { sections },
  }
}

/** The sections with their detected chorus confirmed, or null when \`chorus\` mostly lies outside it. */
function confirmed(sections: readonly SongSection[], chorus: readonly TimeRange[]): SongSection[] | null {
  const unsure = (s: SongSection) =>
    s.label === 'chorus' && (s.confidence ?? 0) < DRAFT_CONFIRMED_CHORUS_CONFIDENCE
  let inside = 0
  let total = 0
  for (const r of chorus) {
    total += r.end - r.start
    for (const s of sections)
      if (unsure(s)) inside += Math.max(0, Math.min(r.end, s.end) - Math.max(r.start, s.start))
  }
  if (inside <= total / 2) return null
  return sections.map((s) => (unsure(s) ? { ...s, confidence: DRAFT_CONFIRMED_CHORUS_CONFIDENCE } : s))
}
