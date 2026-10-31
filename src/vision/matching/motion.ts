import type { GrayImage, MotionAnalysis, RgbaImage } from '../types.ts'

const DEFAULT_MAX_SHIFT = 8
const DEFAULT_HIST_BINS = 32

/** A pair counts as a cut only when its histogram distance exceeds this AND spikes relative to its neighbours. */
const HIST_CUT_ABS = 0.3
/** Same for the camera-compensated residual (0..255). */
const RESIDUAL_CUT_ABS = 25
const CUT_SPIKE_RATIO = 3
const MIN_CUT_GAP_SECONDS = 0.5

/** Box/area-average downsample with Rec.601 luma. */
export function rgbaToGray(src: RgbaImage, outWidth: number, outHeight: number): GrayImage {
  const ow = Math.max(1, Math.floor(outWidth))
  const oh = Math.max(1, Math.floor(outHeight))
  const out = new Uint8Array(ow * oh)
  const sw = src.width
  const sh = src.height
  if (sw === 0 || sh === 0) return { width: ow, height: oh, data: out }

  const xs = boxBounds(sw, ow)
  const ys = boxBounds(sh, oh)
  const data = src.data
  for (let oy = 0; oy < oh; oy++) {
    const y0 = ys[2 * oy]!
    const y1 = ys[2 * oy + 1]!
    for (let ox = 0; ox < ow; ox++) {
      const x0 = xs[2 * ox]!
      const x1 = xs[2 * ox + 1]!
      let sum = 0
      for (let y = y0; y < y1; y++) {
        for (let p = (y * sw + x0) * 4, end = (y * sw + x1) * 4; p < end; p += 4) {
          sum += 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!
        }
      }
      out[oy * ow + ox] = Math.min(255, Math.round(sum / ((y1 - y0) * (x1 - x0))))
    }
  }
  return { width: ow, height: oh, data: out }
}

/** [start, end) source ranges of each output pixel, interleaved; never empty, so upscaling repeats pixels. */
function boxBounds(srcSize: number, outSize: number): Int32Array {
  const bounds = new Int32Array(outSize * 2)
  for (let i = 0; i < outSize; i++) {
    const start = Math.min(srcSize - 1, Math.floor((i * srcSize) / outSize))
    bounds[2 * i] = start
    bounds[2 * i + 1] = Math.max(start + 1, Math.floor(((i + 1) * srcSize) / outSize))
  }
  return bounds
}
/** Mean absolute difference between `cur` and `prev` displaced by (dx, dy), over the overlapping region. */
function shiftedMad(prev: GrayImage, cur: GrayImage, dx: number, dy: number): number {
  const w = cur.width
  const h = cur.height
  const x0 = Math.max(0, dx)
  const x1 = Math.min(w, w + dx)
  const y0 = Math.max(0, dy)
  const y1 = Math.min(h, h + dy)
  if (x1 <= x0 || y1 <= y0) return Number.POSITIVE_INFINITY
  const a = cur.data
  const b = prev.data
  let sum = 0
  for (let y = y0; y < y1; y++) {
    let ia = y * w + x0
    let ib = (y - dy) * w + (x0 - dx)
    for (let x = x0; x < x1; x++, ia++, ib++) {
      const d = a[ia]! - b[ib]!
      sum += d < 0 ? -d : d
    }
  }
  return sum / ((x1 - x0) * (y1 - y0))
}

interface ShiftResult {
  dx: number
  dy: number
  residual: number
}

function searchShift(
  prev: GrayImage,
  cur: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  limit: number,
): ShiftResult {
  let best: ShiftResult = { dx: 0, dy: 0, residual: Number.POSITIVE_INFINITY }
  let bestMag = Number.POSITIVE_INFINITY
  for (let dy = cy - radius; dy <= cy + radius; dy++) {
    if (Math.abs(dy) > limit) continue
    for (let dx = cx - radius; dx <= cx + radius; dx++) {
      if (Math.abs(dx) > limit) continue
      const cost = shiftedMad(prev, cur, dx, dy)
      const mag = dx * dx + dy * dy
      // Ties go to the smaller shift so flat or static frames report no camera motion.
      if (cost < best.residual - 1e-9 || (cost <= best.residual + 1e-9 && mag < bestMag)) {
        best = { dx, dy, residual: cost }
        bestMag = mag
      }
    }
  }
  return best
}

function halve(img: GrayImage): GrayImage {
  const w = img.width >> 1
  const h = img.height >> 1
  const out = new Uint8Array(w * h)
  const src = img.data
  const sw = img.width
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * sw
    const r1 = r0 + sw
    for (let x = 0; x < w; x++) {
      const i = 2 * x
      out[y * w + x] = (src[r0 + i]! + src[r0 + i + 1]! + src[r1 + i]! + src[r1 + i + 1]! + 2) >> 2
    }
  }
  return { width: w, height: h, data: out }
}

function assertSameSize(a: GrayImage, b: GrayImage): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frame size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
}

/**
 * Integer translation (dx, dy) such that cur(x, y) ≈ prev(x − dx, y − dy), i.e. content moved by (dx, dy).
 * Searched coarse-to-fine; residual is the mean abs difference after compensation (0..255).
 */
export function estimateGlobalShift(
  prev: GrayImage,
  cur: GrayImage,
  maxShift: number = DEFAULT_MAX_SHIFT,
): { dx: number; dy: number; residual: number } {
  assertSameSize(prev, cur)
  if (prev.width === 0 || prev.height === 0) return { dx: 0, dy: 0, residual: 0 }
  // Keep at least half of the frame overlapping so tiny overlaps cannot win by chance.
  const limit = Math.max(0, Math.min(Math.floor(maxShift), prev.width >> 1, prev.height >> 1))

  if (limit >= 2 && prev.width >= 32 && prev.height >= 16) {
    const coarse = searchShift(halve(prev), halve(cur), 0, 0, Math.ceil(limit / 2), Math.ceil(limit / 2))
    return searchShift(prev, cur, coarse.dx * 2, coarse.dy * 2, 1, limit)
  }
  return searchShift(prev, cur, 0, 0, limit, limit)
}

/** Mean absolute luma difference (0..255). */
export function frameDifference(prev: GrayImage, cur: GrayImage): number {
  assertSameSize(prev, cur)
  const n = cur.data.length
  if (n === 0) return 0
  return shiftedMad(prev, cur, 0, 0)
}

function histogram(img: GrayImage, bins: number): Float64Array {
  const hist = new Float64Array(bins)
  const data = img.data
  const scale = bins / 256
  for (let i = 0; i < data.length; i++) hist[(data[i]! * scale) | 0]! += 1
  const n = data.length
  if (n > 0) for (let b = 0; b < bins; b++) hist[b]! /= n
  return hist
}

/** Half the L1 distance between normalized luma histograms: 0 = identical, 1 = disjoint. */
export function histogramDistance(prev: GrayImage, cur: GrayImage, bins: number = DEFAULT_HIST_BINS): number {
  const nb = Math.max(1, Math.min(256, Math.floor(bins)))
  const a = histogram(prev, nb)
  const b = histogram(cur, nb)
  let sum = 0
  for (let i = 0; i < nb; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / 2
}

export interface MotionAnalyzer {
  push(t: number, frame: GrayImage): void
  finish(): MotionAnalysis
}

interface PairStats {
  /** Time of the later frame. */
  t: number
  shift: number
  residual: number
  hist: number
}

export function createMotionAnalyzer(opts: { fps: number }): MotionAnalyzer {
  const fps = opts.fps > 0 ? opts.fps : 1
  const pairs: PairStats[] = []
  let prev: GrayImage | null = null
  let width = 0

  return {
    push(t, frame) {
      const cur: GrayImage = { width: frame.width, height: frame.height, data: frame.data.slice() }
      if (prev && prev.width === cur.width && prev.height === cur.height) {
        const { dx, dy, residual } = estimateGlobalShift(prev, cur)
        pairs.push({ t, shift: Math.hypot(dx, dy), residual, hist: histogramDistance(prev, cur) })
      }
      prev = cur
      width = cur.width
    },
    finish() {
      return summarize(pairs, fps, width)
    },
  }
}

function summarize(pairs: PairStats[], fps: number, width: number): MotionAnalysis {
  const n = pairs.length
  const radius = Math.max(3, Math.round(fps))
  const residuals = pairs.map((p) => p.residual)
  const hists = pairs.map((p) => p.hist)
  const camera = pairs.map((p) => (width > 0 ? (p.shift / width) * 100 * fps : 0))

  const cutIdx = detectCuts(pairs, residuals, hists, radius)
  const isCut = new Uint8Array(n)
  for (const i of cutIdx) isCut[i] = 1

  const energy = replaceAtCuts(residuals, isCut, radius)
  const cameraClean = replaceAtCuts(camera, isCut, radius)

  return {
    fps,
    energy,
    camera: cameraClean,
    cuts: cutIdx.map((i) => pairs[i]!.t).sort((a, b) => a - b),
    meanEnergy: mean(energy),
    p90Energy: percentile(energy, 0.9),
    meanCamera: mean(cameraClean),
  }
}

function detectCuts(pairs: PairStats[], residuals: number[], hists: number[], radius: number): number[] {
  const candidates: { i: number; strength: number }[] = []
  for (let i = 0; i < pairs.length; i++) {
    const h = hists[i]!
    const r = residuals[i]!
    const nh = neighbourValues(hists, i, radius, null)
    if (nh.length === 0) continue
    const histSpike = h >= HIST_CUT_ABS && h > CUT_SPIKE_RATIO * median(nh)
    // Compensated residual rather than raw difference: a pan starting abruptly spikes the raw difference.
    const residualSpike =
      r >= RESIDUAL_CUT_ABS && r > CUT_SPIKE_RATIO * median(neighbourValues(residuals, i, radius, null))
    if (histSpike || residualSpike) candidates.push({ i, strength: h + r / 255 })
  }
  candidates.sort((a, b) => b.strength - a.strength)
  const accepted: number[] = []
  for (const c of candidates) {
    const t = pairs[c.i]!.t
    if (accepted.every((j) => Math.abs(pairs[j]!.t - t) >= MIN_CUT_GAP_SECONDS)) accepted.push(c.i)
  }
  return accepted
}

function neighbourValues(values: number[], i: number, radius: number, exclude: Uint8Array | null): number[] {
  const out: number[] = []
  const lo = Math.max(0, i - radius)
  const hi = Math.min(values.length - 1, i + radius)
  for (let j = lo; j <= hi; j++) {
    if (j !== i && !(exclude && exclude[j])) out.push(values[j]!)
  }
  return out
}

function replaceAtCuts(values: number[], isCut: Uint8Array, radius: number): number[] {
  return values.map((v, i) => {
    if (!isCut[i]) return v
    const nb = neighbourValues(values, i, radius, isCut)
    return nb.length > 0 ? median(nb) : 0
  })
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

/** Linear-interpolated percentile, q in 0..1; 0 for empty input. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}
