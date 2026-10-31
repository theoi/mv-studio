/**
 * The song's beat grid as the timeline and preview use it: the detected beats, else beats from the tempo starting at
 * 0 s, and the bar starts once they are found (by the analysis's refinement step or the user; until then nothing
 * snaps to or counts bars). Snapping, ruler ticks, the beat grid and the preview's readout all read it, so they agree
 * with each other and with the shaders' beat grid.
 */
import { gridPosition } from '../../engine/audioFeatures.ts'
import type { AudioAnalysis, Project } from '../../model/index.ts'
import { songAnalysis, timelineDuration } from './project.ts'
import type { BarsState } from './songAnalysis.ts'

export interface BeatGrid {
  /** Beat times in seconds, ascending. */
  beats: number[]
  /** Bar starts in seconds, ascending; empty until the bars are found. */
  downbeats: number[]
  /** Beats in a bar: the typical count between found bar starts, else 4. */
  beatsPerBar: number
  /** Whether the bars are found (so bar starts and the meter are known). */
  detectedBars: boolean
  /** The typical beat length in seconds. */
  beat: number
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Index of the last event at or before t, or -1. */
export function lastIndexAt(events: readonly number[], t: number): number {
  let lo = 0
  let hi = events.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((events[mid] as number) <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** The event nearest to t, or undefined when there are none. */
export function nearestEvent(events: readonly number[], t: number): number | undefined {
  const i = lastIndexAt(events, t)
  const before = events[i]
  const after = events[i + 1]
  if (before === undefined) return after
  if (after === undefined) return before
  return t - before <= after - t ? before : after
}

// Keyed by the arrays and tempo themselves, which edits elsewhere in the analysis (a section drag) leave as they are.
const fromBeats = new WeakMap<
  readonly number[],
  { downbeats: AudioAnalysis['downbeats']; grid: BeatGrid | null }
>()
const fromTempo = new WeakMap<object, { end: number; grid: BeatGrid }>()

function detectedGrid(a: AudioAnalysis): BeatGrid | null {
  const beats = a.beats ?? []
  if (beats.length < 2) return null
  const beat = median(beats.slice(1).map((t, i) => t - (beats[i] as number)))
  const detected = (a.downbeats?.length ?? 0) >= 2
  let beatsPerBar = 4
  if (detected) {
    const counts = (a.downbeats ?? []).slice(1).map((d, i) => {
      const from = lastIndexAt(beats, (a.downbeats?.[i] as number) + beat / 2)
      return lastIndexAt(beats, d + beat / 2) - from
    })
    beatsPerBar = Math.min(7, Math.max(2, Math.round(median(counts)) || 4))
  }
  const downbeats = detected ? [...(a.downbeats ?? [])] : []
  return { beats, downbeats, beatsPerBar, detectedBars: detected, beat }
}

/** The beat grid of the project's song, or null without a song or tempo. */
export function beatGrid(p: Project): BeatGrid | null {
  const a = songAnalysis(p)
  if (!a) return null
  if (a.beats) {
    let hit = fromBeats.get(a.beats)
    if (!hit || hit.downbeats !== a.downbeats) {
      hit = { downbeats: a.downbeats, grid: detectedGrid(a) }
      fromBeats.set(a.beats, hit)
    }
    if (hit.grid) return hit.grid
  }
  const bpm = a.tempo?.bpm
  if (!a.tempo || !bpm || bpm <= 0) return null
  const end = timelineDuration(p)
  const cached = fromTempo.get(a.tempo)
  if (cached?.end === end) return cached.grid
  const beat = 60 / bpm
  const beats: number[] = []
  for (let i = 0; i * beat <= end; i++) beats.push(i * beat)
  const grid = {
    beats,
    downbeats: [],
    beatsPerBar: 4,
    detectedBars: false,
    beat,
  }
  fromTempo.set(a.tempo, { end, grid })
  return grid
}

/** What snapping snaps to: the snap menu's choices (UiState carries them). */
export interface SnapOptions {
  snap: boolean
  beatSnap: boolean
  barSnap: boolean
  sectionSnap: boolean
  edgeSnap: boolean
  playheadSnap: boolean
}

export interface SnapTargets {
  /** Clip edges near what is dragged. */
  edges?: readonly number[]
  /** Section starts and ends. */
  sections?: readonly number[]
  playhead?: number
}

/** The nearest point within tolerance seconds of t among the kinds snapping is on for, or t itself. */
export function snapTo(
  t: number,
  tolerance: number,
  grid: BeatGrid | null,
  options: SnapOptions,
  targets: SnapTargets,
): { t: number; snapped: number | null } {
  let best = t
  let bestD = tolerance
  let snapped: number | null = null
  if (!options.snap) return { t, snapped }
  const consider = (c: number | undefined) => {
    if (c === undefined) return
    const d = Math.abs(c - t)
    if (d < bestD) {
      bestD = d
      best = c
      snapped = c
    }
  }
  if (options.edgeSnap) targets.edges?.forEach(consider)
  if (options.sectionSnap) targets.sections?.forEach(consider)
  if (options.playheadSnap) consider(targets.playhead)
  if (grid && options.barSnap) consider(nearestEvent(grid.downbeats, t))
  if (grid && options.beatSnap) consider(nearestEvent(grid.beats, t))
  return { t: best, snapped }
}

/** Bar and beat at t, both counted from 1, as in "Bar 12, beat 3"; null until the bars are found. */
export function barAt(grid: BeatGrid, t: number): { bar: number; beat: number } | null {
  if (!grid.detectedBars) return null
  const barPos = gridPosition(grid.downbeats, t) ?? 0
  const bar = Math.floor(barPos)
  const barStart = grid.downbeats[bar] ?? grid.downbeats[0] ?? 0
  const beatPos = gridPosition(grid.beats, t) ?? 0
  const startPos = gridPosition(grid.beats, barStart) ?? 0
  const beat = Math.floor(beatPos - Math.round(startPos) + 1e-6)
  return {
    bar: Math.max(1, bar + 1),
    beat: Math.min(grid.beatsPerBar, Math.max(1, beat + 1)),
  }
}

/** Whether a beat time is also a bar start. */
export function isDownbeat(grid: BeatGrid, t: number): boolean {
  const d = nearestEvent(grid.downbeats, t)
  return d !== undefined && Math.abs(d - t) < grid.beat / 4
}

/** The beat at t, counted from 1 at the first beat. */
export function beatAt(grid: BeatGrid, t: number): number {
  return Math.max(1, Math.floor((gridPosition(grid.beats, t) ?? 0) + 1e-6) + 1)
}

/** Bars from start to end: the bar starts in between, or the length in typical bars; null until the bars are found. */
export function barsBetween(grid: BeatGrid | null, start: number, end: number): number | null {
  if (!grid?.detectedBars) return null
  const inside = grid.downbeats.filter((d) => d >= start - grid.beat / 4 && d < end - grid.beat / 4).length
  return inside || Math.max(1, Math.round((end - start) / (grid.beat * grid.beatsPerBar)))
}

/**
 * Why nothing snaps to or counts bars yet, in the words the snap menu, the tempo tooltip and the preview's readout
 * share; undefined once they are found or when there is no analyzed song.
 */
export function barsNote(status: BarsState['status'], short = false): string | undefined {
  if (status === 'finding') return 'Finding bars…'
  if (status !== 'unavailable') return undefined
  return short
    ? 'Bars not found yet'
    : 'Bars not found yet. Analyze again in Assist › Song analysis to look for them.'
}
