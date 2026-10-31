import type { Mask, RgbaImage } from '../types.ts'

const LEVELS = 6
export const COLOR_BINS = LEVELS ** 3
/** Fewer object pixels than this (at the small analysis size) make too thin a colour model to trust. */
const MIN_PIXELS = 12

/** Coarse RGB-cube bin of every pixel. */
export function colorBins(rgba: RgbaImage): Uint8Array {
  const n = rgba.width * rgba.height
  const out = new Uint8Array(n)
  const d = rgba.data
  for (let i = 0, j = 0; i < n; i++, j += 4)
    out[i] =
      ((d[j]! * LEVELS) >> 8) * LEVELS * LEVELS +
      ((d[j + 1]! * LEVELS) >> 8) * LEVELS +
      ((d[j + 2]! * LEVELS) >> 8)
  return out
}

/** Normalized colour histogram of the pixels inside `mask` (same size as the bins), or null if too few. */
export function colorHistogram(bins: Uint8Array, mask: Mask, inside = true): Float32Array | null {
  const hist = new Float32Array(COLOR_BINS)
  let n = 0
  for (let i = 0; i < bins.length; i++) {
    if (mask.data[i]! >= 128 !== inside) continue
    hist[bins[i]!]!++
    n++
  }
  if (n < MIN_PIXELS) return null
  for (let b = 0; b < COLOR_BINS; b++) hist[b]! /= n
  return hist
}

/** Bhattacharyya coefficient of two normalized histograms: 1 = same colours, 0 = no colour in common. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i]! * b[i]!)
  return s
}

export interface ColorModel {
  /** Colours of the object. */
  target: Float32Array
  /** Colours of the rest of the frame where the object was clicked, plus anything rejected as a distractor. */
  rest: Float32Array
  /** Per bin, 0..1: how much more the colour belongs to the object than to the rest. */
  foreground: Float32Array
  /** Mean foreground value over the object's own pixels, the reference for "looks like the object". */
  self: number
}

function withRest(target: Float32Array, rest: Float32Array): ColorModel {
  const foreground = new Float32Array(COLOR_BINS)
  let self = 0
  for (let b = 0; b < COLOR_BINS; b++) {
    foreground[b] = target[b]! / (target[b]! + rest[b]! + 1e-6)
    self += target[b]! * foreground[b]!
  }
  return { target, rest, foreground, self }
}

export function colorModel(bins: Uint8Array, mask: Mask): ColorModel | null {
  const target = colorHistogram(bins, mask)
  const rest = colorHistogram(bins, mask, false)
  return target && rest ? withRest(target, rest) : null
}

/**
 * The model with the colours of something the tracker rejected (a neighbour it merged with, another object it
 * slipped onto) counted as background, so prompts and searches prefer the colours only the object has.
 */
export function withDistractor(model: ColorModel, distractor: Float32Array, weight = 0.3): ColorModel {
  const rest = new Float32Array(COLOR_BINS)
  for (let b = 0; b < COLOR_BINS; b++) rest[b] = model.rest[b]! + weight * distractor[b]!
  return withRest(model.target, rest)
}
/** The model with its object colours moved a little toward how the object looks now. */
export function adapted(model: ColorModel, current: Float32Array, rate: number): ColorModel {
  const target = new Float32Array(COLOR_BINS)
  for (let b = 0; b < COLOR_BINS; b++) target[b] = model.target[b]! * (1 - rate) + current[b]! * rate
  return withRest(target, model.rest)
}
/** Per pixel foreground value under the model. */
export function likelihoodMap(bins: Uint8Array, model: Pick<ColorModel, 'foreground'>): Float32Array {
  const out = new Float32Array(bins.length)
  for (let i = 0; i < bins.length; i++) out[i] = model.foreground[bins[i]!]!
  return out
}

export function meanInside(values: Float32Array, mask: Mask): number {
  let s = 0
  let n = 0
  for (let i = 0; i < values.length; i++) {
    if (mask.data[i]! < 128) continue
    s += values[i]!
    n++
  }
  return n ? s / n : 0
}
