/**
 * Ranges for short exports, on the song's bar grid: the chorus teaser (15-30 s, starting on the strongest chorus)
 * and the Canvas-style loop (3-8 s, a whole number of bars).
 */
import { hasFoundBars, projectDuration } from '../model/queries.ts'
import type { AudioAnalysis, AudioClip, Project, Seconds, SongSection } from '../model/types.ts'
import { beatGridOf } from '../vj/quantize.ts'

export interface TimeRange {
  start: Seconds
  end: Seconds
}

export interface TeaserPick extends TimeRange {
  /** Where the range came from, best first. */
  source: 'chorus' | 'section' | 'energy' | 'start'
  /** 0..1: how sure the pick is the song's highlight. */
  confidence: number
  /** Label of the section it starts on. */
  label?: string
}

export const TEASER_LENGTH = { min: 15, max: 30 } as const
export const LOOP_LENGTH = { min: 3, max: 8 } as const
/** Teaser lengths offered in the export dialog, as the longest a teaser may run. */
export const TEASER_CHOICES = [15, 30] as const

/**
 * The lengths a teaser may take: with a limit, up to it (ending on the last bar before it, so a 15 s teaser fits a
 * 15 s story); without one, 15 to 30 s.
 */
export function teaserWindow(maxLength?: Seconds): { min: Seconds; max: Seconds } {
  return maxLength ? { min: Math.round((maxLength * 2) / 3), max: maxLength } : TEASER_LENGTH
}
/** Window used to find the loudest part when the song has no sections. */
const ENERGY_WINDOW: Seconds = 20

function songClip(project: Project): AudioClip | undefined {
  const songId = project.songAssetId
  return Object.values(project.clips)
    .filter((c): c is AudioClip => c.type === 'audio' && c.enabled && c.assetId === songId)
    .sort((a, b) => a.start - b.start)[0]
}

/** Maps song (asset) time to timeline time through the song's clip, or null when that moment is not on it. */
function songToTimeline(project: Project): (t: Seconds) => Seconds | null {
  const clip = songClip(project)
  if (!clip) return (t) => t
  return (t) => {
    const at = clip.start + (t - clip.sourceStart) / clip.playbackRate
    return at >= clip.start - 1e-6 && at <= clip.start + clip.duration + 1e-6 ? at : null
  }
}

function analysisOf(project: Project): AudioAnalysis | undefined {
  return project.songAssetId ? project.analysis.audio[project.songAssetId] : undefined
}

/**
 * Bar starts on the timeline: the song's bars once found. Empty without them, so teasers and loops are then placed
 * in seconds rather than on guessed bars.
 */
export function barTimes(project: Project): Seconds[] {
  const grid = beatGridOf(project)
  return grid?.downbeats && hasFoundBars(grid) ? grid.downbeats : []
}

function nearest(times: readonly Seconds[], t: Seconds): Seconds {
  let best = t
  let distance = Infinity
  for (const x of times) {
    const d = Math.abs(x - t)
    if (d < distance) {
      distance = d
      best = x
    }
  }
  return best
}

/**
 * Sections to start a teaser on, best first: of the sections labeled chorus (else of the repeated sections), the
 * group that repeats most, then the loudest; within it the loudest occurrence, the earliest on a tie.
 */
function rankedSections(sections: readonly SongSection[]): { sections: SongSection[]; chorus: boolean } {
  const choruses = sections.filter((s) => /chorus/i.test(s.label) && !/pre/i.test(s.label))
  const groupOf = (s: SongSection) => s.repeatGroup ?? -1 - sections.indexOf(s)
  const count = (s: SongSection) => sections.filter((x) => groupOf(x) === groupOf(s)).length
  const repeated = sections.filter((s) => count(s) > 1)
  const pool = choruses.length > 0 ? choruses : repeated
  if (pool.length === 0) return { sections: [], chorus: false }
  const groupEnergy = (s: SongSection) => {
    const members = pool.filter((x) => groupOf(x) === groupOf(s))
    return members.reduce((sum, x) => sum + (x.energy ?? 0), 0) / members.length
  }
  const ranked = [...pool].sort(
    (a, b) =>
      count(b) - count(a) ||
      groupEnergy(b) - groupEnergy(a) ||
      (b.energy ?? 0) - (a.energy ?? 0) ||
      a.start - b.start,
  )
  return { sections: ranked, chorus: choruses.length > 0 }
}

/** Start of the loudest ENERGY_WINDOW of the song, in song time. */
function loudestStart(analysis: AudioAnalysis): Seconds | null {
  const energy = analysis.energy
  if (!energy || energy.values.length === 0 || energy.rate <= 0) return null
  const n = Math.max(1, Math.round(ENERGY_WINDOW * energy.rate))
  const values = energy.values
  if (values.length <= n) return 0
  let sum = values.slice(0, n).reduce((a, b) => a + b, 0)
  let best = sum
  let bestIndex = 0
  for (let i = n; i < values.length; i++) {
    sum += (values[i] as number) - (values[i - n] as number)
    if (sum > best) {
      best = sum
      bestIndex = i - n + 1
    }
  }
  return bestIndex / energy.rate
}

/** Moves `start` to the nearest bar and picks a bar-aligned end with a length in [min, max], closest to `wanted`. */
function onBars(
  bars: readonly Seconds[],
  start: Seconds,
  wanted: Seconds,
  length: { min: Seconds; max: Seconds },
  limit: Seconds,
): TimeRange {
  const s = bars.length > 0 ? nearest(bars, start) : start
  const target = Math.min(length.max, Math.max(length.min, wanted))
  const ends = bars.filter(
    (b) => b - s >= length.min - 1e-6 && b - s <= length.max + 1e-6 && b <= limit + 1e-6,
  )
  const end = ends.length > 0 ? nearest(ends, s + target) : Math.min(limit, s + target)
  return { start: s, end }
}

/**
 * A teaser range moved onto bars and kept 15 to 30 s long inside the timeline: the start goes to the nearest bar and
 * the end to the bar nearest the wanted length. For ranges dragged on the export dialog's mini song lane.
 */
export function fitTeaserRange(
  project: Project,
  range: TimeRange,
  length: { min: Seconds; max: Seconds } = TEASER_LENGTH,
): TimeRange {
  const duration = projectDuration(project)
  if (duration <= length.min) return { start: 0, end: Math.max(0, duration) }
  // Leave room for the minimum length before the end of the timeline.
  const start = Math.max(0, Math.min(range.start, duration - length.min))
  const fitted = onBars(barTimes(project), start, range.end - range.start, length, duration)
  return fitted.end - fitted.start >= length.min - 1e-6
    ? fitted
    : { start: duration - length.min, end: duration }
}

/** A teaser starting on a song section (Section context menu › Export as teaser). Null when it is not on the timeline. */
export function sectionTeaserRange(project: Project, sectionId: string): TimeRange | null {
  const section = analysisOf(project)?.sections?.find((s) => s.id === sectionId)
  if (!section) return null
  const toTimeline = songToTimeline(project)
  const start = toTimeline(section.start)
  if (start === null) return null
  return fitTeaserRange(project, { start, end: toTimeline(section.end) ?? projectDuration(project) })
}

/** Timeline end of the song section playing at `t`. Null without sections. */
export function sectionEndAt(project: Project, t: Seconds): Seconds | null {
  const toTimeline = songToTimeline(project)
  for (const s of analysisOf(project)?.sections ?? []) {
    const start = toTimeline(s.start)
    const end = toTimeline(s.end) ?? projectDuration(project)
    if (start !== null && t >= start - 1e-3 && t < end - 1e-3) return end
  }
  return null
}

/** The chorus teaser range: the strongest chorus, on bars, 15 to 30 s long. Null when the timeline is empty. */
export function teaserRange(
  project: Project,
  length: { min: Seconds; max: Seconds } = TEASER_LENGTH,
): TeaserPick | null {
  const duration = projectDuration(project)
  if (duration <= 0) return null
  if (duration <= length.min) return { start: 0, end: duration, source: 'start', confidence: 0 }
  const analysis = analysisOf(project)
  const toTimeline = songToTimeline(project)
  const fit = (start: Seconds, wanted: Seconds) =>
    fitTeaserRange(project, { start, end: start + wanted }, length)

  const ranked = rankedSections(analysis?.sections ?? [])
  // A strong chorus too close to the end for a full teaser gives way to an earlier one of the same rank order.
  const candidates = ranked.sections
    .map((section) => ({ section, start: toTimeline(section.start), end: toTimeline(section.end) }))
    .filter((c): c is { section: SongSection; start: Seconds; end: Seconds | null } => c.start !== null)
  const pick = candidates.find((c) => c.start + length.min <= duration + 1e-6) ?? candidates[0]
  if (pick)
    return {
      ...fit(pick.start, (pick.end ?? duration) - pick.start),
      source: ranked.chorus ? 'chorus' : 'section',
      // A chorus is as likely the highlight as its label is right (0.8 from repeated lyrics, 1 when typed).
      confidence: ranked.chorus ? Math.min(1, Math.max(0, pick.section.confidence ?? 0.6)) : 0.4,
      label: pick.section.label,
    }
  const loud = analysis ? loudestStart(analysis) : null
  const loudStart = loud === null ? null : toTimeline(loud)
  if (loudStart !== null) return { ...fit(loudStart, ENERGY_WINDOW), source: 'energy', confidence: 0.3 }
  return { ...fit(0, ENERGY_WINDOW), source: 'start', confidence: 0 }
}

export interface LoopPick extends TimeRange {
  bars: number
  /** Seconds of the loop's start blended into its end. */
  crossfade: Seconds
}

/** The longest seamless crossfade for a loop of `length`: half a second, at most a quarter of the loop. */
export function loopCrossfade(length: Seconds): Seconds {
  return Math.min(0.5, length / 4)
}

/**
 * A loop of `bars` bars starting on the bar nearest `start`, moved later if the crossfade needs more timeline before
 * it and earlier if it would run past the end. Null without a beat grid or when the timeline is too short.
 */
export function fitLoopRange(project: Project, start: Seconds, bars: number): LoopPick | null {
  const grid = barTimes(project)
  const duration = projectDuration(project)
  const n = Math.max(1, Math.round(bars))
  if (grid.length < n + 1) return null
  const last = grid.findLastIndex((_, i) => i + n < grid.length && (grid[i + n] as number) <= duration + 1e-6)
  if (last < 0) return null
  let i = Math.min(grid.indexOf(nearest(grid, start)), last)
  const room = (k: number) =>
    (grid[k] as number) >= loopCrossfade((grid[k + n] as number) - (grid[k] as number)) - 1e-6
  while (i < last && !room(i)) i++
  const s = grid[i] as number
  const e = grid[i + n] as number
  return { start: s, end: e, bars: n, crossfade: Math.min(loopCrossfade(e - s), s) }
}

/** A loop length: whole bars, or plain seconds (bars 0) for a song without a beat grid. */
export interface LoopLength {
  bars: number
  seconds: Seconds
}

/**
 * A loop of `length` placed near `start`: on bars when it has bars (null when they don't fit), else clamped inside
 * the timeline with room for the crossfade before it.
 */
export function placeLoop(project: Project, start: Seconds, length: LoopLength): LoopPick | null {
  if (length.bars > 0) return fitLoopRange(project, start, length.bars)
  const duration = projectDuration(project)
  if (duration <= 0) return null
  const len = Math.min(duration, length.seconds)
  const s = Math.min(Math.max(start, loopCrossfade(len)), Math.max(0, duration - len))
  return { start: s, end: s + len, bars: 0, crossfade: Math.min(loopCrossfade(len), s) }
}

/**
 * The loop lengths to offer around `start`: 1, 2, 4 or 8 bars that last 3 to 8 s there, or 4, 6 and 8 s without a
 * beat grid.
 */
export function loopLengths(project: Project, start: Seconds): LoopLength[] {
  if (barTimes(project).length < 2) return [4, 6, 8].map((seconds) => ({ bars: 0, seconds }))
  const lengths: LoopLength[] = []
  for (const bars of [1, 2, 4, 8]) {
    const pick = fitLoopRange(project, start, bars)
    const seconds = pick ? pick.end - pick.start : 0
    if (seconds >= LOOP_LENGTH.min - 1e-6 && seconds <= LOOP_LENGTH.max + 1e-6)
      lengths.push({ bars, seconds })
  }
  return lengths
}

/**
 * A Canvas loop range: 4, 2 or 1 bars (3-8 s) starting on the bar where the teaser starts, with enough timeline
 * before it for the crossfade. Without a beat grid, 6 s.
 */
export function loopRange(
  project: Project,
  length: { min: Seconds; max: Seconds } = LOOP_LENGTH,
  around: Seconds = teaserRange(project)?.start ?? 0,
): LoopPick | null {
  const duration = projectDuration(project)
  if (duration <= 0) return null
  const bars = barTimes(project)
  const fallback = (start: Seconds) =>
    placeLoop(project, start, { bars: 0, seconds: Math.max(length.min, Math.min(length.max, 6)) })
  if (bars.length < 2) return fallback(around)
  const first = bars.findIndex((b) => b >= around - 1e-6)
  const from = first < 0 ? bars.length - 1 : first
  for (let i = from; i < bars.length; i++) {
    const start = bars[i] as number
    for (const n of [4, 2, 1, 8]) {
      const end = bars[i + n]
      if (end === undefined || end > duration + 1e-6) continue
      const len = end - start
      if (len < length.min - 1e-6 || len > length.max + 1e-6) continue
      const crossfade = loopCrossfade(len)
      if (start < crossfade - 1e-6) continue
      return { start, end, bars: n, crossfade }
    }
  }
  return fallback(around)
}
