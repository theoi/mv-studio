import { describe, expect, it } from 'vitest'
import { BAND_EDGES_HZ, computeAudioFeatures, FEATURE_RATE } from '../../../src/analysis/features/features.ts'
import { concat, mix, sine, SR } from './synth.ts'

const noOnsets = new Float32Array(10)
const features = (mono: Float32Array) => computeAudioFeatures(mono, SR, noOnsets, 100)
const column = (bands: number[][], b: number, from: number, to: number) =>
  bands.slice(from, to).map((frame) => frame[b] as number)
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] as number

describe('computeAudioFeatures', () => {
  it('stores 0..1 values frame-major at the feature rate', () => {
    const f = features(concat(sine(100, 2), sine(3000, 2)))
    const frames = 4 * FEATURE_RATE + 1
    expect(f.rate).toBe(FEATURE_RATE)
    expect(f.bandEdgesHz).toEqual(BAND_EDGES_HZ)
    expect(f.loudness).toHaveLength(frames)
    expect(f.bands).toHaveLength(frames)
    for (const frame of f.bands) expect(frame).toHaveLength(BAND_EDGES_HZ.length - 1)
    const all = [...f.loudness, ...f.bands.flat()]
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...all)).toBeLessThanOrEqual(1)
  })

  it('puts a tone in the band containing its frequency', () => {
    const { bands } = features(concat(sine(100, 2), sine(3000, 2)))
    const bass = BAND_EDGES_HZ.findIndex((e, i) => e <= 100 && 100 < (BAND_EDGES_HZ[i + 1] as number))
    const highMids = BAND_EDGES_HZ.findIndex((e, i) => e <= 3000 && 3000 < (BAND_EDGES_HZ[i + 1] as number))
    expect(median(column(bands, bass, 10, 90))).toBeGreaterThan(0.9)
    expect(median(column(bands, bass, 110, 190))).toBeLessThan(0.1)
    expect(median(column(bands, highMids, 10, 90))).toBeLessThan(0.1)
    expect(median(column(bands, highMids, 110, 190))).toBeGreaterThan(0.9)
  })

  it('keeps a band far below the loudest band from filling the full range', () => {
    const { bands } = features(mix(sine(100, 3, 0.5), sine(3000, 3, 0.005)))
    expect(median(column(bands, 1, 10, 140))).toBeGreaterThan(0.9)
    expect(median(column(bands, 4, 10, 140))).toBeLessThan(0.7)
  })

  it('follows loudness relative to the loud parts of the signal', () => {
    const { loudness } = features(concat(sine(1000, 2, 0.05), sine(1000, 2, 0.5)))
    const quiet = median(loudness.slice(10, 90))
    expect(median(loudness.slice(110, 190))).toBeGreaterThan(0.95)
    // 20 dB below the loud part on a 36 dB scale.
    expect(quiet).toBeGreaterThan(0.35)
    expect(quiet).toBeLessThan(0.55)
  })

  it('returns zeros for silence', () => {
    const f = features(new Float32Array(SR * 2))
    expect(Math.max(...f.loudness, ...f.bands.flat())).toBe(0)
    expect(f.onsets).toEqual([])
  })
})
