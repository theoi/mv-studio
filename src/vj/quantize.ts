/**
 * Quantizing recorded hits to the song's beat grid, with a strength (0 = as played, 1 = exactly on the grid).
 * Grid points subdivide each analysed beat interval, so they follow tempo changes; outside the analysed beats the
 * nearest interval is extended.
 */
import { hasFoundBars } from '../model/queries.ts'
import type { Project, Seconds } from '../model/types.ts'
import type { QuantizeGrid, QuantizeSettings, VjEvent } from './types.ts'

/** Beat and bar times on the timeline. */
export interface BeatGrid {
  beats: Seconds[]
  downbeats?: Seconds[]
}

const DIVISIONS: Record<Exclude<QuantizeGrid, 'bar'>, number> = { '1/4': 1, '1/8': 2, '1/8T': 3, '1/16': 4 }

/**
 * The song's beat grid in timeline time: analysed beats (mapped through the song's audio clip), or a grid from the
 * detected tempo, or null when the song has not been analysed.
 */
export function beatGridOf(project: Project): BeatGrid | null {
  const songId = project.songAssetId
  const analysis = songId ? project.analysis.audio[songId] : undefined
  if (!songId || !analysis) return null
  const clip = Object.values(project.clips)
    .filter((c) => c.type === 'audio' && c.enabled && c.assetId === songId)
    .sort((a, b) => a.start - b.start)[0]
  const toTimeline = (assetTime: Seconds): Seconds | null => {
    if (!clip || clip.type !== 'audio') return assetTime
    const t = clip.start + (assetTime - clip.sourceStart) / clip.playbackRate
    return t >= clip.start - 1e-6 && t <= clip.start + clip.duration + 1e-6 ? t : null
  }
  const map = (times: readonly Seconds[] | undefined) =>
    (times ?? []).map(toTimeline).filter((t): t is Seconds => t !== null)
  const beats = map(analysis.beats)
  if (beats.length >= 2) {
    const downbeats = map(analysis.downbeats)
    return hasFoundBars({ downbeats }) ? { beats, downbeats } : { beats }
  }
  const bpm = analysis.tempo?.bpm
  const duration = clip ? clip.duration : (analysis.beats?.at(-1) ?? 0)
  if (!bpm || bpm <= 0 || duration <= 0) return null
  const period = 60 / bpm
  const start = clip ? clip.start : 0
  const grid: Seconds[] = []
  for (let t = start; t <= start + duration + 1e-9; t += period) grid.push(t)
  return grid.length >= 2 ? { beats: grid } : null
}

function points(grid: BeatGrid, q: QuantizeGrid): { times: Seconds[]; division: number } {
  if (q !== 'bar') return { times: grid.beats, division: DIVISIONS[q] }
  if (grid.downbeats && hasFoundBars(grid)) return { times: grid.downbeats, division: 1 }
  // Bars not found: the nearest beat, rather than a guessed bar.
  return { times: grid.beats, division: 1 }
}

/** The grid point nearest to `t`. */
export function nearestGridTime(t: Seconds, grid: BeatGrid, q: QuantizeGrid): Seconds {
  const { times, division } = points(grid, q)
  if (times.length < 2) return times[0] ?? t
  let i: number
  if (t < (times[0] as number)) i = 0
  else if (t >= (times[times.length - 1] as number)) i = times.length - 2
  else {
    let lo = 0
    let hi = times.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((times[mid] as number) <= t) lo = mid
      else hi = mid
    }
    i = lo
  }
  const a = times[i] as number
  const step = ((times[i + 1] as number) - a) / division
  return a + Math.round((t - a) / step) * step
}

export function quantizeTime(t: Seconds, grid: BeatGrid, settings: QuantizeSettings): Seconds {
  const strength = Math.max(0, Math.min(1, settings.strength))
  return t + (nearestGridTime(t, grid, settings.grid) - t) * strength
}

/**
 * Quantizes presses and releases. Knob moves keep their timing, and events at or before `from` (the state the take
 * started with) stay put. A release never lands within `minLength` of its press: if the grid would collapse a held
 * pad, it keeps its played length.
 */
export function quantizeEvents(
  events: readonly VjEvent[],
  grid: BeatGrid,
  settings: QuantizeSettings,
  from: Seconds,
  minLength: Seconds,
): VjEvent[] {
  const lastPress = new Map<string, { played: Seconds; at: Seconds }>()
  const out = events.map((e, order) => {
    if (e.type === 'amount' || e.t <= from + 1e-9) {
      if (e.type === 'press') lastPress.set(e.pad, { played: e.t, at: e.t })
      return { e, order }
    }
    let t = Math.max(from, quantizeTime(e.t, grid, settings))
    if (e.type === 'press') lastPress.set(e.pad, { played: e.t, at: t })
    else {
      const press = lastPress.get(e.pad)
      if (press && t - press.at < minLength) t = press.at + Math.max(minLength, e.t - press.played)
    }
    return { e: { ...e, t }, order }
  })
  out.sort((a, b) => a.e.t - b.e.t || a.order - b.order)
  return out.map((x) => x.e)
}
