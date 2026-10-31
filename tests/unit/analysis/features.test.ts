import { describe, expect, it } from 'vitest'
import {
  BAND_EDGES_HZ,
  computeAudioFeatures,
  FEATURE_RATE,
  featureReference,
} from '../../../src/analysis/features/features.ts'
import { concat, mix, mix as mix2, sine, SR } from './synth.ts'

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
    expect(median(column(bands, bass, 10, 90))).toBeGreaterThan(0.85)
    expect(median(column(bands, bass, 110, 190))).toBeLessThan(0.1)
    expect(median(column(bands, highMids, 10, 90))).toBeLessThan(0.1)
    expect(median(column(bands, highMids, 110, 190))).toBeGreaterThan(0.85)
  })

  it('keeps a band far below the loudest band from filling the full range', () => {
    const { bands } = features(mix(sine(100, 3, 0.5), sine(3000, 3, 0.005)))
    expect(median(column(bands, 1, 10, 140))).toBeGreaterThan(0.85)
    expect(median(column(bands, 4, 10, 140))).toBeLessThan(0.7)
  })

  it('puts the loud parts near 0.9 and drops a quiet section to the bottom of the range', () => {
    const { loudness } = features(concat(sine(1000, 2, 0.05), sine(1000, 2, 0.5)))
    expect(median(loudness.slice(110, 190))).toBeCloseTo(0.9, 1)
    // The song spans 20 dB, so the quiet half sits at the bottom of its range.
    expect(median(loudness.slice(10, 90))).toBeLessThan(0.1)
  })

  it('spreads the small level changes of a compressed master over a visible range', () => {
    // A level that swings by 6 dB twice a second, like a loud master between hits.
    const swing = sine(1000, 4, 0.5).map((v, i) => v * (0.75 + 0.25 * Math.sin((2 * Math.PI * 2 * i) / SR)))
    const { loudness } = features(swing)
    const sorted = loudness.slice(10, 190).sort((a, b) => a - b)
    const p10 = sorted[Math.floor(sorted.length * 0.1)] as number
    const p90 = sorted[Math.floor(sorted.length * 0.9)] as number
    expect(p90).toBeLessThan(0.95)
    expect(p90 - p10).toBeGreaterThan(0.3)
  })

  it('compresses peaks above the loud level instead of clipping them', () => {
    // Short bursts 3 dB and 6 dB above a steady level.
    const steady = sine(1000, 4, 0.1)
    steady.set(sine(1000, 0.1, 0.141), SR)
    steady.set(sine(1000, 0.1, 0.2), 2.5 * SR)
    const { loudness, rate } = features(steady)
    const at = (from: number, to: number) => loudness.slice(Math.round(from * rate), Math.round(to * rate))
    expect(median(at(1.5, 2.3))).toBeCloseTo(0.9, 1)
    const small = Math.max(...at(0.9, 1.3))
    const big = Math.max(...at(2.4, 2.8))
    expect(small).toBeGreaterThan(0.93)
    expect(big).toBeGreaterThan(small)
    expect(big).toBeLessThan(1)
  })

  it('keeps a stem far below its mix low when normalized against the mix', () => {
    const mix = mix2(sine(100, 3, 0.5), sine(3000, 3, 0.5))
    const bleed = sine(3000, 3, 0.005)
    const own = features(bleed)
    const against = computeAudioFeatures(bleed, SR, noOnsets, 100, featureReference(mix, SR))
    expect(median(own.loudness.slice(10, 140))).toBeGreaterThan(0.85)
    expect(median(against.loudness.slice(10, 140))).toBeLessThan(0.1)
    expect(median(column(against.bands, 4, 10, 140))).toBeLessThan(0.1)
    const loudStem = computeAudioFeatures(sine(3000, 3, 0.5), SR, noOnsets, 100, featureReference(mix, SR))
    expect(median(column(loudStem.bands, 4, 10, 140))).toBeGreaterThan(0.85)
  })

  it('returns zeros for silence', () => {
    const f = features(new Float32Array(SR * 2))
    expect(Math.max(...f.loudness, ...f.bands.flat())).toBe(0)
    expect(f.onsets).toEqual([])
  })
})
