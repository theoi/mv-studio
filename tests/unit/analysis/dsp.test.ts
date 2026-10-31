import { describe, expect, it } from 'vitest'
import { ComplexFFT, RealFFT } from '../../../src/analysis/dsp/fft.ts'
import { createStreamResampler, mixToMono, resample } from '../../../src/analysis/dsp/resample.ts'
import { melFilterbank } from '../../../src/analysis/dsp/spectral.ts'
import { rng, sine } from './synth.ts'

function naiveDft(x: number[]): { re: number[]; im: number[] } {
  const n = x.length
  const re: number[] = []
  const im: number[] = []
  for (let k = 0; k < n; k++) {
    let r = 0
    let i = 0
    for (let j = 0; j < n; j++) {
      r += x[j] * Math.cos((2 * Math.PI * j * k) / n)
      i -= x[j] * Math.sin((2 * Math.PI * j * k) / n)
    }
    re.push(r)
    im.push(i)
  }
  return { re, im }
}

describe('fft', () => {
  it('complex FFT matches a naive DFT and inverts', () => {
    const r = rng(1)
    const n = 64
    const x = Array.from({ length: n }, r)
    const re = Float64Array.from(x)
    const im = new Float64Array(n)
    new ComplexFFT(n).transform(re, im)
    const ref = naiveDft(x)
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 9)
      expect(im[k]).toBeCloseTo(ref.im[k], 9)
    }
    new ComplexFFT(n).transform(re, im, true)
    for (let k = 0; k < n; k++) expect(re[k] / n).toBeCloseTo(x[k], 12)
  })

  it.each([4, 8, 256, 2048])('real FFT of size %i matches a naive DFT and round-trips', (n) => {
    const r = rng(7)
    const x = Array.from({ length: n }, r)
    const fft = new RealFFT(n)
    const re = new Float64Array(fft.bins)
    const im = new Float64Array(fft.bins)
    fft.forward(x, re, im)
    const ref = naiveDft(x)
    for (let k = 0; k < fft.bins; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 8)
      expect(im[k]).toBeCloseTo(ref.im[k], 8)
    }
    const back = new Float64Array(n)
    fft.inverse(re, im, back)
    for (let k = 0; k < n; k++) expect(back[k]).toBeCloseTo(x[k], 10)
  })

  it('rejects non power-of-two sizes', () => {
    expect(() => new RealFFT(100)).toThrow(RangeError)
  })
})

describe('resample', () => {
  it.each([
    [44100, 22050],
    [44100, 16000],
    [48000, 22050],
    [22050, 44100],
    [44100, 11025],
  ])('preserves an in-band sine from %i Hz to %i Hz', (from, to) => {
    const out = resample(sine(440, 1, 1, from), from, to)
    expect(Math.abs(out.length - to)).toBeLessThanOrEqual(1)
    const ref = sine(440, 1, 1, to)
    let err = 0
    for (let i = 200; i < out.length - 200; i++) err = Math.max(err, Math.abs(out[i] - ref[i]))
    expect(err).toBeLessThan(2e-3)
  })

  it('suppresses content above the new Nyquist frequency', () => {
    const out = resample(sine(15000, 1, 1, 44100), 44100, 16000)
    let peak = 0
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeLessThan(1e-3)
  })

  it('is deterministic and keeps DC', () => {
    const x = new Float32Array(10000).fill(0.25)
    const a = resample(x, 44100, 22050)
    expect(resample(x, 44100, 22050)).toEqual(a)
    expect(a[2000]).toBeCloseTo(0.25, 5)
  })

  it.each([
    [44100, 48000],
    [48000, 44100],
    [44100, 16000],
  ])('streams from %i Hz to %i Hz block by block with the same samples as one call', (from, to) => {
    const r = rng(7)
    const x = Float32Array.from({ length: 30_011 }, () => r() * 2 - 1)
    const stream = createStreamResampler(from, to)
    const parts: Float32Array[] = []
    // Uneven blocks, including empty ones and ones shorter than the kernel.
    for (let at = 0, k = 0; at < x.length; k++) {
      const size = [0, 3, 1234, 7, 5000, 64][k % 6] as number
      parts.push(stream.push(x.subarray(at, at + size)))
      at += size
    }
    parts.push(stream.flush())
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    expect(out).toEqual(resample(x, from, to))
  })

  it('mixes channels to mono', () => {
    const m = mixToMono([Float32Array.of(1, 1), Float32Array.of(0, -1)])
    expect(Array.from(m)).toEqual([0.5, 0])
  })
})

describe('mel filterbank', () => {
  it('produces ordered, non-empty triangular filters', () => {
    const fb = melFilterbank(22050, 2048, 64, 30, 8000)
    expect(fb).toHaveLength(64)
    for (let i = 1; i < fb.length; i++) expect(fb[i].start).toBeGreaterThanOrEqual(fb[i - 1].start)
    for (const f of fb) expect(f.weights.length).toBeGreaterThan(0)
  })
})
