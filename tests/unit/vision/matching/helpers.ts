import type { ClipVisionIndex, GrayImage, MotionAnalysis } from '../../../../src/vision/types.ts'

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function unit(v: Float32Array): Float32Array {
  let sq = 0
  for (const x of v) sq += x * x
  const inv = 1 / Math.sqrt(sq)
  return v.map((x) => x * inv)
}

export function randomUnit(dim: number, rng: () => number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = gaussian(rng)
  return unit(v)
}

/** Unit vector of sum(weights[k] · vectors[k]) plus isotropic noise of total norm ≈ `noise`. */
export function mix(
  vectors: Float32Array[],
  weights: number[],
  noise: number,
  rng: () => number,
): Float32Array {
  const dim = vectors[0]!.length
  const out = new Float32Array(dim)
  vectors.forEach((v, k) => {
    for (let i = 0; i < dim; i++) out[i]! += weights[k]! * v[i]!
  })
  const n = randomUnit(dim, rng)
  for (let i = 0; i < dim; i++) out[i]! += noise * n[i]!
  return unit(out)
}

export const ZERO_MOTION: MotionAnalysis = {
  fps: 1,
  energy: [],
  camera: [],
  cuts: [],
  meanEnergy: 0,
  p90Energy: 0,
  meanCamera: 0,
}

export function makeIndex(opts: {
  mediaId: string
  frames: Float32Array[]
  times?: number[]
  hubness?: number[]
  duration?: number
  motion?: Partial<MotionAnalysis>
}): ClipVisionIndex {
  const dim = opts.frames[0]?.length ?? 0
  const embeddings = new Float32Array(opts.frames.length * dim)
  opts.frames.forEach((f, i) => embeddings.set(f, i * dim))
  const times = opts.times ?? opts.frames.map((_, i) => i)
  return {
    version: 1,
    mediaId: opts.mediaId,
    duration: opts.duration ?? times.length,
    model: 'test',
    dim,
    times,
    embeddings,
    hubness: opts.hubness ?? times.map(() => 0),
    motion: { ...ZERO_MOTION, ...opts.motion },
  }
}

/** Smooth random texture (uniform noise blurred twice with a 3x3 box). */
export function makeTexture(width: number, height: number, rng: () => number, offset = 0): GrayImage {
  let buf = new Float32Array(width * height).map(() => rng() * 255)
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(buf.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0
        let count = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
            sum += buf[yy * width + xx]!
            count++
          }
        }
        next[y * width + x] = sum / count
      }
    }
    buf = next
  }
  // Re-stretch contrast lost to blurring.
  let lo = Infinity
  let hi = -Infinity
  for (const v of buf) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const data = new Uint8Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round(((buf[i]! - lo) / (hi - lo)) * 255 * 0.6 + offset)))
  }
  return { width, height, data }
}

export function crop(src: GrayImage, x0: number, y0: number, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const from = (y0 + y) * src.width + x0
    data.set(src.data.subarray(from, from + width), y * width)
  }
  return { width, height, data }
}
