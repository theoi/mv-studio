/** Beat-grid math for planners: grids with fallbacks, section coverage, and beat- or bar-aligned cut points. */
import type { LyricLine, Seconds } from '../model/types.ts'
import { meanOver, type EnergyAt, type SectionInfo, type SongInfo } from './inputs.ts'
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
    // Stable ids, so a brief written against these parts still matches when the plan is expanded.
    parts.push({ id: `part-${i + 1}`, label: `Part ${i + 1}`, start, end, energy: energy ?? 0.5 })
  }
  const values = parts.map((p) => p.energy)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max - min > 1e-6) for (const p of parts) p.energy = (p.energy - min) / (max - min)
  return parts
}

/**
 * When word `index` of a line (split into `words`) is sung, the line sung from `start` to `end`: the word's own
 * timing, else in proportion to the letters before it.
 */
export function wordTime(
  item: { line: LyricLine; start: Seconds; end: Seconds },
  words: string[],
  index: number,
): Seconds {
  const timed = item.line.words[index]
  if (item.line.words.length === words.length && timed && timed.end > timed.start) return timed.start
  const before = words.slice(0, index).join(' ').length + (index > 0 ? 1 : 0)
  return item.start + ((item.end - item.start) * before) / Math.max(1, item.line.text.length)
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

/** How much louder (or quieter) than the rest of its section a bar must be to cut twice (or half) as often. */
const BAR_CONTRAST = 0.15

export interface PhraseOptions {
  /** Song energy over a span, 0..1 within the song (energyScale). */
  energyAt?: EnergyAt
  /** The next section cuts faster: speed up through the last bar into it. */
  lift?: boolean
}

/**
 * Cut times in [start, end) at about `k` beats per shot, phrased bar by bar the way an editor follows the music
 * inside a section: a bar clearly louder than the rest of the section cuts twice as often, a clearly quieter one
 * half as often, and with `lift` the last bar speeds up into the next section. Shots of 4 beats or more start on
 * bar lines and 2-beat shots on beats 1 and 3. Without energy or a lift this is cutTimes().
 */
export function phrasedCutTimes(
  start: Seconds,
  end: Seconds,
  k: number,
  grid: BeatGrid,
  options: PhraseOptions = {},
): Seconds[] {
  const bars = [start, ...grid.downbeats.filter((d) => d > start + EPS && d < end - EPS)]
  const energies = bars.map((b, i) => options.energyAt?.(b, bars[i + 1] ?? end))
  const known = energies.filter((e): e is number => e !== undefined)
  const mean = known.length >= 3 ? known.reduce((a, b) => a + b, 0) / known.length : undefined
  const lift = !!options.lift && bars.length > 1
  if (mean === undefined && !lift) return cutTimes(start, end, k, grid)
  const barK = bars.map((_, i) => {
    let kk = k
    const e = energies[i]
    if (mean !== undefined && e !== undefined) {
      if (e - mean >= BAR_CONTRAST) kk = k / 2
      else if (mean - e >= BAR_CONTRAST) kk = k * 2
    }
    if (lift && i === bars.length - 1) kk = Math.min(kk, k / 2)
    kk = Math.min(16, Math.max(1, kk))
    while (kk * grid.beatLength < MIN_SHOT) kk *= 2
    return kk
  })

  const minShot = Math.max(MIN_SHOT, Math.min(grid.beatLength * 0.75, (end - start) / 2))
  const near = (list: Seconds[], t: Seconds) => list.some((b) => Math.abs(b - t) < grid.beatLength / 4)
  const cuts = [start]
  let bar = 0
  // Beat position within the bar (0 = downbeat), unknown until the first bar line.
  let pos = near(grid.downbeats, start) ? 0 : -1
  // A section that starts between beats gets onto the grid at the first beat that fits.
  let since = near(grid.beats, start) ? 0 : Infinity
  for (const t of grid.beats) {
    if (t <= start + EPS || t >= end - EPS) continue
    if (bar + 1 < bars.length && t >= (bars[bar + 1] as number) - grid.beatLength / 4) {
      bar++
      pos = 0
    } else if (pos >= 0) pos++
    since++
    const kk = barK[bar] as number
    const aligned = kk >= 4 ? pos === 0 : kk === 2 ? pos < 0 || pos % 2 === 0 : true
    // Back on bar lines after faster cuts, take the first bar line within half a bar of the pace.
    const due = kk >= 4 ? since >= kk - 2 : since >= kk
    if (due && aligned && t - (cuts[cuts.length - 1] as number) >= minShot && end - t >= minShot) {
      cuts.push(t)
      since = 0
    }
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
