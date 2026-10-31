/** Beat-grid math for planners: grids with fallbacks, section coverage, and beat- or bar-aligned cut points. */
import { newId } from '../model/factory.ts'
import type { Seconds } from '../model/types.ts'
import { meanOver, type SectionInfo, type SongInfo } from './inputs.ts'
import type { Pace } from './plan.ts'

export const FALLBACK_BPM = 120
/** Shortest shot the planners create; faster cuts read as flicker. */
export const MIN_SHOT: Seconds = 0.35
const EPS = 1e-3

export interface BeatGrid {
  beats: Seconds[]
  downbeats: Seconds[]
  beatLength: Seconds
  bpm: number
  /** True when beats were synthesized from the tempo (or 120 BPM) because no beat analysis exists. */
  estimated: boolean
}

const round3 = (t: number) => Math.round(t * 1000) / 1000

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function beatGrid(song: SongInfo): BeatGrid {
  let beats = song.beats
  let estimated = false
  if (beats.length < 2) {
    const bpm = song.bpm && song.bpm > 30 && song.bpm < 300 ? song.bpm : FALLBACK_BPM
    const step = 60 / bpm
    const first = beats[0] ?? 0
    beats = []
    for (let t = first; t < song.duration - EPS; t += step) beats.push(round3(t))
    estimated = true
  }
  const diffs = beats.slice(1).map((b, i) => b - (beats[i] as number))
  const beatLength = median(diffs.filter((d) => d > 0.15 && d < 2)) ?? 60 / (song.bpm || FALLBACK_BPM)
  const bpm = song.bpm && song.bpm > 0 ? song.bpm : 60 / beatLength
  const downbeats =
    song.downbeats.length >= 2 && !estimated ? song.downbeats : beats.filter((_, i) => i % 4 === 0)
  return { beats, downbeats, beatLength, bpm, estimated }
}

/** Sections covering the whole song without gaps; when analysis has none, 8-bar parts. */
export function sectionsFor(song: SongInfo, grid: BeatGrid): SectionInfo[] {
  const duration = song.duration
  if (song.sections.length > 0) {
    const sorted = [...song.sections].sort((a, b) => a.start - b.start)
    return sorted.map((s, i) => ({
      ...s,
      start: i === 0 ? 0 : s.start,
      end: i === sorted.length - 1 ? duration : (sorted[i + 1] as SectionInfo).start,
    }))
  }
  const barLength = grid.beatLength * 4
  const partLength = Math.max(8, barLength * 8)
  const count = Math.max(1, Math.round(duration / partLength))
  const parts: SectionInfo[] = []
  for (let i = 0; i < count; i++) {
    const start = (duration * i) / count
    const end = (duration * (i + 1)) / count
    const energy = meanOver(song.energy, start, end)
    parts.push({ id: newId(), label: `Part ${i + 1}`, start, end, energy: energy ?? 0.5 })
  }
  const values = parts.map((p) => p.energy)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max - min > 1e-6) for (const p of parts) p.energy = (p.energy - min) / (max - min)
  return parts
}

const BEATS_PER_CUT: Record<Pace, number> = { 'very-fast': 1, fast: 2, medium: 4, slow: 8, 'very-slow': 16 }

export function beatsPerCut(pace: Pace, beatLength: Seconds): number {
  let k = BEATS_PER_CUT[pace]
  while (k * beatLength < MIN_SHOT) k *= 2
  return k
}

/**
 * Cut times in [start, end): `start`, then every `k` beats, counted from `start` when it is on the beat (on a bar
 * start when k ≥ 4), otherwise from the first bar start.
 */
export function cutTimes(start: Seconds, end: Seconds, k: number, grid: BeatGrid): Seconds[] {
  const minShot = Math.max(MIN_SHOT, Math.min(grid.beatLength * 0.75, (end - start) / 2))
  const inside = grid.beats.filter((b) => b > start + EPS && b < end - EPS)
  const near = (list: Seconds[]) => list.some((b) => Math.abs(b - start) < grid.beatLength / 4)
  let anchor = near(grid.beats) ? k - 1 : 0
  if (k >= 4 && !near(grid.downbeats)) {
    const bar = grid.downbeats.find((d) => d > start + EPS && d < end - EPS)
    if (bar !== undefined) {
      const i = inside.findIndex((b) => Math.abs(b - bar) < grid.beatLength / 2)
      if (i >= 0) anchor = i
    }
  }
  const cuts = [start]
  for (let i = anchor; i < inside.length; i += k) {
    const t = inside[i] as number
    if (t - (cuts[cuts.length - 1] as number) >= minShot && end - t >= minShot) cuts.push(t)
  }
  return cuts
}

/**
 * Cut times for shots of about `target` seconds (never over `max`), landing on bar starts where possible. Used
 * for generated video, where one request returns one clip of a fixed length.
 */
export function cutTimesByLength(
  start: Seconds,
  end: Seconds,
  target: Seconds,
  max: Seconds,
  grid: BeatGrid,
): Seconds[] {
  const candidates = (grid.downbeats.length ? grid.downbeats : grid.beats).filter(
    (t) => t > start + EPS && t < end - EPS,
  )
  const cuts = [start]
  let last = start
  while (end - last > max + EPS) {
    const window = candidates.filter((t) => t >= last + Math.min(target * 0.6, max) && t <= last + max)
    let next: number
    if (window.length > 0) {
      next = window.reduce((best, t) =>
        Math.abs(t - last - target) < Math.abs(best - last - target) ? t : best,
      )
    } else {
      next = last + Math.min(target, max)
    }
    if (end - next < MIN_SHOT * 2) break
    cuts.push(next)
    last = next
  }
  return cuts
}

/** Consecutive [start, end) spans from cut times. */
export function spans(cuts: Seconds[], end: Seconds): { start: Seconds; end: Seconds }[] {
  return cuts.map((start, i) => ({ start, end: i + 1 < cuts.length ? (cuts[i + 1] as number) : end }))
}

/** Deterministic random numbers (mulberry32), so the same seed gives the same plan. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
