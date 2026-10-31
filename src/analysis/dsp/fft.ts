/**
 * Radix-2 FFTs on Float64Array buffers. Sizes must be powers of two.
 */
export class ComplexFFT {
  readonly n: number
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two, got ${n}`)
    }
    this.n = n
    const bits = Math.round(Math.log2(n))
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(Math.max(1, n >> 1))
    this.sin = new Float64Array(Math.max(1, n >> 1))
    for (let k = 0; k < n >> 1; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n)
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n)
    }
  }

  /** In-place transform. The inverse is unnormalized (no division by n). */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (i < j) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    const cos = this.cos
    const sin = this.sin
    const sign = inverse ? -1 : 1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sign * sin[k * step]
        for (let a = k; a < n; a += size) {
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

/** Real-input FFT of size n computed with a complex FFT of size n/2. Produces n/2+1 bins. */
export class RealFFT {
  readonly n: number
  readonly bins: number
  private readonly half: ComplexFFT
  private readonly zr: Float64Array
  private readonly zi: Float64Array
  private readonly wr: Float64Array
  private readonly wi: Float64Array

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 4 || (n & (n - 1)) !== 0) {
      throw new RangeError(`Real FFT size must be a power of two >= 4, got ${n}`)
    }
    this.n = n
    this.bins = n / 2 + 1
    const m = n / 2
    this.half = new ComplexFFT(m)
    this.zr = new Float64Array(m)
    this.zi = new Float64Array(m)
    this.wr = new Float64Array(m + 1)
    this.wi = new Float64Array(m + 1)
    for (let k = 0; k <= m; k++) {
      this.wr[k] = Math.cos((2 * Math.PI * k) / n)
      this.wi[k] = -Math.sin((2 * Math.PI * k) / n)
    }
  }

  /** Forward transform of `input` (length n) into outRe/outIm (length >= n/2+1). Unnormalized. */
  forward(input: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const m = this.n / 2
    const zr = this.zr
    const zi = this.zi
    for (let k = 0; k < m; k++) {
      zr[k] = input[2 * k]
      zi[k] = input[2 * k + 1]
    }
    this.half.transform(zr, zi)
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k
      const k2 = k === 0 ? 0 : m - k
      const ar = zr[k1]
      const ai = zi[k1]
      const br = zr[k2]
      const bi = -zi[k2]
      const er = (ar + br) * 0.5
      const ei = (ai + bi) * 0.5
      const or = (ai - bi) * 0.5
      const oi = -(ar - br) * 0.5
      const wr = this.wr[k]
      const wi = this.wi[k]
      outRe[k] = er + wr * or - wi * oi
      outIm[k] = ei + wr * oi + wi * or
    }
  }

  /** Inverse of `forward`: bins (length n/2+1) to a real signal of length n, normalized by 1/n. */
  inverse(inRe: ArrayLike<number>, inIm: ArrayLike<number>, output: Float64Array | Float32Array): void {
    const m = this.n / 2
    const zr = this.zr
    const zi = this.zi
    for (let k = 0; k < m; k++) {
      const ar = inRe[k]
      const ai = inIm[k]
      const br = inRe[m - k]
      const bi = -inIm[m - k]
      const er = (ar + br) * 0.5
      const ei = (ai + bi) * 0.5
      const dr = (ar - br) * 0.5
      const di = (ai - bi) * 0.5
      // multiply by W^-k = (wr, -wi)
      const wr = this.wr[k]
      const wi = -this.wi[k]
      const or = dr * wr - di * wi
      const oi = dr * wi + di * wr
      zr[k] = er - oi
      zi[k] = ei + or
    }
    this.half.transform(zr, zi, true)
    const scale = 1 / m
    for (let k = 0; k < m; k++) {
      output[2 * k] = zr[k] * scale
      output[2 * k + 1] = zi[k] * scale
    }
  }
}

/** Periodic Hann window (matches numpy/torch `hann_window(n, periodic=True)`). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}
