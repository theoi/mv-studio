import { JobError } from '../../shared/jobs.ts'
import type { DepthMap } from '../types.ts'

export interface PrepareDepthOptions {
  /** Edge-sharpening radius as a fraction of the map width. 0 disables sharpening. */
  sharpen?: number
  /** Local depth range (0..1) above which a neighbourhood counts as an edge and is sharpened. */
  edgeThreshold?: number
  /** Max-filter radius as a fraction of the map width. 0 disables dilation. */
  dilate?: number
  /** Box-blur radius (applied twice) as a fraction of the map width. 0 disables blurring. */
  blur?: number
  /** Percentiles mapped to 0 and 255. */
  low?: number
  high?: number
}

const DEFAULTS: Required<PrepareDepthOptions> = {
  sharpen: 0.008,
  edgeThreshold: 0.12,
  dilate: 0.007,
  blur: 0.0025,
  low: 0.02,
  high: 0.98,
}
/** Below this input range (out of 255) the map is treated as nearly flat and not stretched, so noise stays noise. */
const MIN_RANGE = 24

/**
 * Conditions a model depth map for the parallax renderer:
 * 1. Robust range normalization (percentiles, so a few outliers don't flatten the scene).
 * 2. Edge sharpening: across depth discontinuities each pixel snaps to the nearer of its local min and max.
 *    Model depth ramps over several pixels at silhouettes; the renderer turns every ramp pixel into a
 *    different shift, which bends straight background lines over the whole ramp width.
 * 3. Foreground dilation: near regions grow past the object silhouette. Model depth edges are soft and sit
 *    inside the object, so without this the renderer stretches the object's own edge pixels across the
 *    revealed background ("rubber sheet" tearing); with it, the stretched pixels are background.
 * 4. A small blur so the dilated step becomes a short ramp the ray march can intersect without stair steps.
 */
export function prepareDepthForParallax(depth: DepthMap, opts: PrepareDepthOptions = {}): DepthMap {
  const o = { ...DEFAULTS, ...opts }
  const { width, height } = depth
  const n = width * height
  if (depth.data.length !== n)
    throw new JobError('invalid-input', `Depth data has ${depth.data.length} values, expected ${n}`)
  const out = normalizeRange(depth.data, o.low, o.high)
  const sharpenRadius = Math.round(o.sharpen * width)
  if (sharpenRadius > 0) sharpenEdges(out, width, height, sharpenRadius, Math.round(o.edgeThreshold * 255))
  const dilateRadius = Math.round(o.dilate * width)
  if (dilateRadius > 0)
    separable(out, width, height, (src, dst, start, stride, len) =>
      slidingExtreme(src, dst, start, stride, len, dilateRadius, 1),
    )
  const blurRadius = Math.round(o.blur * width)
  if (blurRadius > 0) {
    for (let pass = 0; pass < 2; pass++)
      separable(out, width, height, (src, dst, start, stride, len) =>
        boxBlur(src, dst, start, stride, len, blurRadius),
      )
  }
  return { ...depth, data: out }
}

/**
 * Depth (0..1) to keep fixed during a move: a near, centre-weighted value, which lands on the main subject
 * in typical footage. Call it on the same map that is passed to the renderer.
 */
export function suggestFocus(depth: DepthMap): number {
  const { width, height, data } = depth
  if (width <= 0 || height <= 0 || data.length < width * height) return 0.5
  const hist = new Float64Array(256)
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40_000)))
  let total = 0
  for (let y = 0; y < height; y += step) {
    const dy = (y + 0.5) / height - 0.5
    for (let x = 0; x < width; x += step) {
      const dx = (x + 0.5) / width - 0.5
      const w = Math.exp(-(dx * dx) / (2 * 0.22 * 0.22) - (dy * dy) / (2 * 0.3 * 0.3))
      hist[data[y * width + x]!]! += w
      total += w
    }
  }
  if (total <= 0) return 0.5
  return percentile(hist, total, 0.8) / 255
}

function normalizeRange(data: Uint8Array, low: number, high: number): Uint8Array {
  const hist = new Float64Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]!]!++
  let lo = percentile(hist, data.length, low)
  let hi = percentile(hist, data.length, high)
  if (hi - lo < MIN_RANGE) {
    const mid = (lo + hi) / 2
    lo = Math.max(0, mid - MIN_RANGE / 2)
    hi = Math.min(255, lo + MIN_RANGE)
    lo = hi - MIN_RANGE
  }
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)))
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = lut[data[i]!]!
  return out
}

/** Toggle filter: where the local range reaches `threshold`, snaps each value to the nearer of its local min and max. */
function sharpenEdges(data: Uint8Array, width: number, height: number, r: number, threshold: number): void {
  const lo = data.slice()
  const hi = data.slice()
  separable(lo, width, height, (src, dst, start, stride, len) =>
    slidingExtreme(src, dst, start, stride, len, r, -1),
  )
  separable(hi, width, height, (src, dst, start, stride, len) =>
    slidingExtreme(src, dst, start, stride, len, r, 1),
  )
  for (let i = 0; i < data.length; i++) {
    const a = lo[i]!
    const b = hi[i]!
    if (b - a < threshold) continue
    const v = data[i]!
    data[i] = v - a <= b - v ? a : b
  }
}

/** Value at which the cumulative weight reaches `q` of `total`. */
function percentile(hist: Float64Array, total: number, q: number): number {
  const target = q * total
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!
    if (acc >= target && acc > 0) return v
  }
  return 255
}

type LineFilter = (src: Uint8Array, dst: Uint8Array, start: number, stride: number, len: number) => void

/** Applies a 1-D filter along rows, then columns, in place. */
function separable(data: Uint8Array, width: number, height: number, filter: LineFilter): void {
  const tmp = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) filter(data, tmp, y * width, 1, width)
  for (let x = 0; x < width; x++) filter(tmp, data, x, width, height)
}

let dequeBuffer = new Int32Array(0)

/** Sliding-window maximum (sign 1) or minimum (sign -1) over [i - r, i + r] with a monotonic deque, O(len). */
function slidingExtreme(
  src: Uint8Array,
  dst: Uint8Array,
  start: number,
  stride: number,
  len: number,
  r: number,
  sign: 1 | -1,
): void {
  if (dequeBuffer.length < len) dequeBuffer = new Int32Array(len)
  const dq = dequeBuffer
  let head = 0
  let tail = 0
  let next = 0
  for (let i = 0; i < len; i++) {
    const right = Math.min(len - 1, i + r)
    for (; next <= right; next++) {
      const v = sign * src[start + next * stride]!
      while (tail > head && sign * src[start + dq[tail - 1]! * stride]! <= v) tail--
      dq[tail++] = next
    }
    while (dq[head]! < i - r) head++
    dst[start + i * stride] = src[start + dq[head]! * stride]!
  }
}

/** Mean over [i - r, i + r] with edge clamping, O(len). */
function boxBlur(
  src: Uint8Array,
  dst: Uint8Array,
  start: number,
  stride: number,
  len: number,
  r: number,
): void {
  const at = (i: number) => src[start + Math.max(0, Math.min(len - 1, i)) * stride]!
  const size = 2 * r + 1
  let sum = 0
  for (let i = -r; i <= r; i++) sum += at(i)
  for (let i = 0; i < len; i++) {
    dst[start + i * stride] = Math.round(sum / size)
    sum += at(i + r + 1) - at(i - r)
  }
}
