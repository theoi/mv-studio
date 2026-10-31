import type { ClipMatch, ClipVisionIndex, Mood, TimeRange } from '../types.ts'
import { cosineToAll, dot, normalize } from './embeddings.ts'
import { MOOD_ENERGY_PRIOR } from './prompts.ts'

const DEFAULT_RANGE_SECONDS = 3
const DEFAULT_TOP_FRACTION = 0.4
const DEFAULT_WEIGHTS = { semantic: 1.0, mood: 0.6, energy: 0.5 } as const
/** Spreads the 0..1 energy fit over roughly the same range as a z-score. */
const ENERGY_Z_SCALE = 3

/** Mean cosine of each frame to the reference prompt embeddings. */
export function frameHubness(embeddings: Float32Array, dim: number, reference: Float32Array[]): number[] {
  const n = dim > 0 ? Math.floor(embeddings.length / dim) : 0
  const refs = reference.filter((r) => r.length === dim).map(normalize)
  const out = new Array<number>(n).fill(0)
  if (refs.length === 0) return out
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const r of refs) sum += dot(embeddings, r, i * dim, 0, dim)
    out[i] = sum / refs.length
  }
  return out
}

export interface SemanticScore {
  score: number
  frameScores: Float32Array
  bestRange: TimeRange
}

export function scoreSemantic(
  index: ClipVisionIndex,
  q: Float32Array,
  opts: { duration?: number; topFraction?: number } = {},
): SemanticScore {
  const frameScores = cosineToAll(index, q)
  for (let i = 0; i < frameScores.length; i++) frameScores[i]! -= index.hubness[i] ?? 0
  const length = rangeLength(index, opts.duration)
  return {
    score: topMean(frameScores, opts.topFraction ?? DEFAULT_TOP_FRACTION),
    frameScores,
    bestRange: bestWindow(index.times, frameScores, length, index.duration, 1),
  }
}

function rangeLength(index: ClipVisionIndex, duration: number | undefined): number {
  const d = duration !== undefined && duration > 0 ? duration : DEFAULT_RANGE_SECONDS
  return Math.max(0, Math.min(d, index.duration))
}

/** Mean of the top ceil(fraction·n) values (at least one); 0 for empty input. */
function topMean(values: Float32Array, fraction: number): number {
  const n = values.length
  if (n === 0) return 0
  const k = Math.min(n, Math.max(1, Math.ceil(Math.max(0, fraction) * n)))
  const sorted = Float32Array.from(values).sort()
  let sum = 0
  for (let i = n - k; i < n; i++) sum += sorted[i]!
  return sum / k
}

/**
 * Window [s, s + length] inside [0, clipDuration] whose samples (at `times`, sorted ascending) have the best mean
 * score; `direction` 1 maximizes, −1 minimizes. Candidate starts are the sample times and clipDuration − length.
 */
function bestWindow(
  times: readonly number[],
  scores: ArrayLike<number>,
  length: number,
  clipDuration: number,
  direction: 1 | -1,
): TimeRange {
  const maxStart = Math.max(0, clipDuration - length)
  const n = Math.min(times.length, scores.length)
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + scores[i]!

  let best: TimeRange = { start: 0, end: length }
  let bestValue = Number.NEGATIVE_INFINITY
  const consider = (start: number): void => {
    const s = Math.min(maxStart, Math.max(0, start))
    const lo = lowerBound(times, s, n)
    const hi = upperBound(times, s + length, n)
    if (hi <= lo) return
    const value = (direction * (prefix[hi]! - prefix[lo]!)) / (hi - lo)
    if (value > bestValue + 1e-12) {
      bestValue = value
      best = { start: s, end: s + length }
    }
  }
  for (let i = 0; i < n; i++) consider(times[i]!)
  consider(maxStart)
  return best
}

/** First index in times[0..n) with times[i] >= value. */
function lowerBound(times: readonly number[], value: number, n: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid]! < value - 1e-9) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index in times[0..n) with times[i] > value. */
function upperBound(times: readonly number[], value: number, n: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid]! <= value + 1e-9) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Raw activity of a clip, comparable only within one library. */
export function clipEnergyLevel(index: ClipVisionIndex): number {
  // Camera motion reads as energy too, but much less than subject motion, and its unit (% width/s) runs larger.
  return index.motion.meanEnergy + 0.15 * index.motion.meanCamera
}

export interface RankInput {
  library: ClipVisionIndex[]
  textVector?: Float32Array
  moodVector?: Float32Array
  mood?: Mood
  energy?: number
  duration?: number
  weights?: { semantic?: number; mood?: number; energy?: number }
}

export function rankClips(input: RankInput): ClipMatch[] {
  const { library } = input
  if (library.length === 0) return []
  const weights = { ...DEFAULT_WEIGHTS, ...stripUndefined(input.weights) }

  const semantic = input.textVector
    ? library.map((clip) => scoreSemantic(clip, input.textVector!, { duration: input.duration }))
    : null
  const semanticZ = semantic ? zScores(semantic.map((s) => s.score)) : null
  const moodZ = input.moodVector
    ? zScores(library.map((clip) => scoreSemantic(clip, input.moodVector!).score))
    : null

  const target = energyTarget(input)
  const energyFit = target === null ? null : energyFitScores(library, target)

  const matches = library.map((clip, i): ClipMatch => {
    const components = {
      semantic: semanticZ ? semanticZ[i]! : null,
      mood: moodZ ? moodZ[i]! : null,
      energy: energyFit ? energyFit[i]! : null,
    }
    const score =
      weights.semantic * (components.semantic ?? 0) +
      weights.mood * (components.mood ?? 0) +
      weights.energy * (components.energy ?? 0)
    const bestRange = semantic ? semantic[i]!.bestRange : energyRange(clip, input.duration, target)
    return { mediaId: clip.mediaId, score, components, bestRange }
  })

  return matches.sort(
    (a, b) => b.score - a.score || (a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0),
  )
}

function stripUndefined(w: RankInput['weights']): Partial<Record<'semantic' | 'mood' | 'energy', number>> {
  const out: Partial<Record<'semantic' | 'mood' | 'energy', number>> = {}
  if (w?.semantic !== undefined) out.semantic = w.semantic
  if (w?.mood !== undefined) out.mood = w.mood
  if (w?.energy !== undefined) out.energy = w.energy
  return out
}

function energyTarget(input: RankInput): number | null {
  if (input.energy !== undefined && Number.isFinite(input.energy))
    return Math.min(1, Math.max(0, input.energy))
  return input.mood ? MOOD_ENERGY_PRIOR[input.mood] : null
}

function zScores(values: number[]): number[] {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n
  const std = Math.sqrt(variance)
  if (!(std >= 1e-6)) return values.map(() => 0)
  return values.map((v) => (v - mean) / std)
}

/** Fit of each clip's activity percentile to the target, mapped to roughly z-scale. */
function energyFitScores(library: ClipVisionIndex[], target: number): number[] {
  const levels = library.map(clipEnergyLevel)
  return levels.map((level) => {
    const fit = 1 - Math.abs(percentileRank(levels, level) - target)
    return (fit - 0.5) * ENERGY_Z_SCALE
  })
}

/** Mid-rank percentile of `value` among `values` (which contains it), 0..1; 0.5 for a single value. */
function percentileRank(values: number[], value: number): number {
  if (values.length < 2) return 0.5
  let less = 0
  let equal = 0
  for (const v of values) {
    if (v < value) less++
    else if (v === value) equal++
  }
  return (less + (equal - 1) / 2) / (values.length - 1)
}

/**
 * Without a text query, picks the most active window, or the calmest one when the requested energy is low
 * (a "calm" request should not land on the clip's busiest seconds).
 */
function energyRange(clip: ClipVisionIndex, duration: number | undefined, target: number | null): TimeRange {
  const length = rangeLength(clip, duration)
  const { energy, fps } = clip.motion
  if (energy.length === 0 || !(fps > 0)) return { start: 0, end: length }
  // Energy sample i describes the step from frame i to i + 1; place it at the midpoint.
  const times = energy.map((_, i) => (i + 0.5) / fps)
  return bestWindow(times, energy, length, clip.duration, target !== null && target < 0.5 ? -1 : 1)
}
