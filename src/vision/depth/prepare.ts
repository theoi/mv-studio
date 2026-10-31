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
  /**
   * Near structures narrower than about twice this (fraction of the map width) count as thin: branches, wires,
   * railings. Around them `thinDilate` and `thinBlur` replace `dilate` and `blur`. 0 treats everything as large.
   */
  thinRadius?: number
  thinDilate?: number
  thinBlur?: number
  /** Percentiles mapped to 0 and 255. */
  low?: number
  high?: number
}

const DEFAULTS: Required<PrepareDepthOptions> = {
  sharpen: 0.008,
  edgeThreshold: 0.12,
  dilate: 0.007,
  blur: 0.0025,
  thinRadius: 0.012,
  thinDilate: 0.015,
  thinBlur: 0.01,
  low: 0.02,
  high: 0.98,
}
/** Below this input range (out of 255) the map is treated as nearly flat and not stretched, so noise stays noise. */
const MIN_RANGE = 24
/**
 * A pixel is near when it is `edgeThreshold` nearer than the farthest point within this radius (fraction of width).
 * Inside a large region only a band this wide along its edge is near, so this must stay above 2·`thinRadius` or
 * that band would count as thin.
 */
const NEAR_RADIUS = 0.04

/**
 * Conditions a model depth map for the parallax renderer:
 * 1. Robust range normalization (percentiles, so a few outliers don't flatten the scene).
 * 2. Edge sharpening: across depth discontinuities each pixel snaps to the nearer of its local min and max.
 *    Model depth ramps over several pixels at silhouettes; the renderer turns every ramp pixel into a
 *    different shift, which bends straight background lines over the whole ramp width.
 * 3. Foreground dilation: near regions grow past the object silhouette. Model depth edges are soft and sit
 *    inside the object, so without this the renderer stretches the object's own edge pixels across the
 *    revealed background ("rubber sheet" tearing); with it, the stretched pixels are background.
 * 4. A blur that turns the dilated step into a ramp. The background the camera reveals beside a near object is
 *    filled from the ramp. Beside a large object (a person, an umbrella) a short ramp keeps straight background
 *    lines straight up to the silhouette; a long one bends them over its whole width. Around thin near
 *    structures (branches, fences) over a detailed background, a short ramp stretches a few background pixels
 *    into streaks that cover much of the frame, so there the dilation and the ramp are about 2 % of the width,
 *    which spreads the fill and moves a tangle of twigs as one layer.
 */
export function prepareDepthForParallax(depth: DepthMap, opts: PrepareDepthOptions = {}): DepthMap {
  const o = { ...DEFAULTS, ...opts }
  const { width, height } = depth
  const n = width * height
  if (depth.data.length !== n)
    throw new JobError('invalid-input', `Depth data has ${depth.data.length} values, expected ${n}`)
  const base = normalizeRange(depth.data, o.low, o.high)
  const sharpenRadius = Math.round(o.sharpen * width)
  const edgeStep = Math.round(o.edgeThreshold * 255)
  if (sharpenRadius > 0) sharpenEdges(base, width, height, sharpenRadius, edgeStep)
  const out = ramp(base, width, height, o.dilate, o.blur)
  const thin = Math.round(o.thinRadius * width)
  if (thin <= 0) return { ...depth, data: out }
  const weight = thinWeight(base, width, height, thin, edgeStep)
  if (!weight) return { ...depth, data: out }
  // The long ramp reaches this far from a thin structure; the weight covers it, then fades out.
  const spread = Math.round((o.thinDilate + 2 * o.thinBlur) * width)
  separable(weight, width, height, (src, dst, start, stride, len) =>
    slidingExtreme(src, dst, start, stride, len, spread, 1),
  )
  const fade = Math.max(1, Math.round(o.thinBlur * width))
  for (let pass = 0; pass < 2; pass++)
    separable(weight, width, height, (src, dst, start, stride, len) =>
      boxBlur(src, dst, start, stride, len, fade),
    )
  const long = ramp(base, width, height, o.thinDilate, o.thinBlur)
  for (let i = 0; i < n; i++) out[i] = Math.round(out[i]! + ((long[i]! - out[i]!) * weight[i]!) / 255)
  return { ...depth, data: out }
}

/** Dilation by `dilate`, then a box blur of radius `blur` applied twice (both fractions of the width). */
function ramp(base: Uint8Array, width: number, height: number, dilate: number, blur: number): Uint8Array {
  const out = base.slice()
  const dilateRadius = Math.round(dilate * width)
  if (dilateRadius > 0)
    separable(out, width, height, (src, dst, start, stride, len) =>
      slidingExtreme(src, dst, start, stride, len, dilateRadius, 1),
    )
  const blurRadius = Math.round(blur * width)
  if (blurRadius > 0) {
    for (let pass = 0; pass < 2; pass++)
      separable(out, width, height, (src, dst, start, stride, len) =>
        boxBlur(src, dst, start, stride, len, blurRadius),
      )
  }
  return out
}

/**
 * 255 on near pixels that belong to a structure thinner than 2·`radius`, else 0; null when there are none. Near
 * means at least `step` nearer than the farthest point around. A near pixel is thin when no pixel of its own region
 * within `radius` steps lies deeper than `radius` inside it, so the edge of a large region never counts as thin, and
 * a thin structure beside a large region still does.
 */
function thinWeight(
  base: Uint8Array,
  width: number,
  height: number,
  radius: number,
  step: number,
): Uint8Array | null {
  const far = base.slice()
  const r = Math.max(1, Math.round(NEAR_RADIUS * width))
  separable(far, width, height, (src, dst, start, stride, len) =>
    slidingExtreme(src, dst, start, stride, len, r, -1),
  )
  const near = new Uint8Array(base.length)
  for (let i = 0; i < near.length; i++) near[i] = base[i]! - far[i]! >= step ? 1 : 0
  const steps = stepsToDeep(near, distanceInside(near, width, height), width, height, radius)
  const weight = new Uint8Array(base.length)
  let any = false
  for (let i = 0; i < weight.length; i++)
    if (near[i] && steps[i] === 255) {
      weight[i] = 255
      any = true
    }
  return any ? weight : null
}

/**
 * Steps (8-connected, never leaving `mask`) from each pixel of `mask` to the nearest pixel at least `radius` inside
 * it, up to `radius` (at most 254); 255 farther. A plain max filter of `inside` over a square window would also reach a deep pixel
 * of another region close by: across the corners of the window, beside a round or diagonal edge.
 */
function stepsToDeep(
  mask: Uint8Array,
  inside: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const limit = Math.min(radius, 254)
  const steps = new Uint8Array(mask.length).fill(255)
  const queue = new Int32Array(mask.length)
  let tail = 0
  for (let i = 0; i < mask.length; i++)
    if (mask[i] && inside[i]! >= radius) {
      steps[i] = 0
      queue[tail++] = i
    }
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!
    const next = steps[i]! + 1
    if (next > limit) continue
    const x = i % width
    const y = (i - x) / width
    for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
      for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        const j = yy * width + xx
        if (mask[j] && steps[j]! > next) {
          steps[j] = next
          queue[tail++] = j
        }
      }
  }
  return steps
}

/** Distance in pixels (3-4 chamfer, capped at 255) from each pixel of `mask` to the nearest pixel outside it. */
function distanceInside(mask: Uint8Array, width: number, height: number): Uint8Array {
  const d = new Int32Array(mask.length)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1 << 20 : 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!d[i]) continue
      let v = d[i]!
      if (x > 0) v = Math.min(v, d[i - 1]! + 3)
      if (y > 0) {
        v = Math.min(v, d[i - width]! + 3)
        if (x > 0) v = Math.min(v, d[i - width - 1]! + 4)
        if (x < width - 1) v = Math.min(v, d[i - width + 1]! + 4)
      }
      d[i] = v
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (!d[i]) continue
      let v = d[i]!
      if (x < width - 1) v = Math.min(v, d[i + 1]! + 3)
      if (y < height - 1) {
        v = Math.min(v, d[i + width]! + 3)
        if (x < width - 1) v = Math.min(v, d[i + width + 1]! + 4)
        if (x > 0) v = Math.min(v, d[i + width - 1]! + 4)
      }
      d[i] = v
    }
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round(d[i]! / 3))
  return out
}
/**
 * Depth (0..1) to keep fixed during a move: a near, centre-weighted value, which lands on the main subject
 * in typical footage. Call it on the same map that is passed to the renderer.
 */
export function suggestFocus(depth: Pick<DepthMap, 'width' | 'height' | 'data'>): number {
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
