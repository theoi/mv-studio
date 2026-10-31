import { ANALYSIS_SAMPLE_RATE, analyzeSpectrum, type SpectralAnalysis } from '../frontend.ts'
import { mixToMono, resample } from '../dsp/resample.ts'
import { quantile, throwIfAborted } from '../dsp/stats.ts'
import { onsetStrength } from './onset.ts'
import { estimateTempo, type TempoOptions } from './tempo.ts'
import { dpBeatTrack } from './dp.ts'
import { type BeatGrid, inferBarPositions, makeGrid } from './grid.ts'

/**
 * The flux onset of a centered 2048-point frame peaks slightly before the perceived beat;
 * this constant (seconds) was measured against Beat This! on the development set.
 */
export const DSP_BEAT_OFFSET = 0.02

export interface DecodedAudio {
  sampleRate: number
  channels: Float32Array[]
}

export function toAnalysisMono(audio: DecodedAudio): Float32Array {
  return resample(mixToMono(audio.channels), audio.sampleRate, ANALYSIS_SAMPLE_RATE)
}

/** Evidence per beat that it starts a bar: bass onsets plus harmonic change across the beat. */
export function heuristicDownbeatLikelihood(spec: SpectralAnalysis, beats: number[]): number[] {
  const low = onsetStrength(spec, { bandLimit: 8 })
  const fps = spec.fps
  const n = beats.length
  const bass = beats.map((t) => {
    const c = Math.round(t * fps)
    let m = 0
    for (let k = c - 3; k <= c + 3; k++) if (k >= 0 && k < low.length) m = Math.max(m, low[k])
    return m
  })
  const meanChroma = (t0: number, t1: number) => {
    const v = new Float64Array(12)
    const a = Math.max(0, Math.round(t0 * fps))
    const z = Math.min(spec.frames, Math.round(t1 * fps))
    for (let f = a; f < z; f++) for (let k = 0; k < 12; k++) v[k] += spec.chroma[f * 12 + k]
    let s = 0
    for (const x of v) s += x * x
    const nn = Math.sqrt(s) || 1
    return v.map((x) => x / nn)
  }
  const change = beats.map((t, i) => {
    if (i < 2 || i + 2 >= n) return 0
    const before = meanChroma(beats[i - 2], t)
    const after = meanChroma(t, beats[i + 2])
    let d = 0
    for (let k = 0; k < 12; k++) d += before[k] * after[k]
    return 1 - d
  })
  const b95 = quantile(bass, 0.95) || 1
  const c95 = quantile(change, 0.95) || 1
  return beats.map(
    (_, i) => 0.2 + 0.6 * (0.5 * Math.min(1, bass[i] / b95) + 0.5 * Math.min(1, change[i] / c95)),
  )
}

export interface FastBeatResult {
  grid: BeatGrid
  onset: Float32Array
}

export function trackBeatsFast(
  spec: SpectralAnalysis,
  tempoOptions: TempoOptions = {},
  signal?: AbortSignal,
): FastBeatResult {
  const onset = onsetStrength(spec)
  throwIfAborted(signal)
  const tempo = estimateTempo(onset, spec.fps, tempoOptions)
  // Tightness tuned on the development set (studio productions hold tempo closely).
  const frames = dpBeatTrack(onset, tempo.period, { tightness: 1200 })
  const beats = frames.map((f) => f / spec.fps + DSP_BEAT_OFFSET).filter((t) => t >= 0 && t < spec.duration)
  const bar = inferBarPositions(heuristicDownbeatLikelihood(spec, beats), { meters: [4] })
  return { grid: makeGrid('dsp', beats, bar, tempo.candidates, false), onset }
}

export function analyzeMono(
  mono22k: Float32Array,
  signal?: AbortSignal,
): { spec: SpectralAnalysis } & FastBeatResult {
  const spec = analyzeSpectrum(mono22k, ANALYSIS_SAMPLE_RATE, signal)
  return { spec, ...trackBeatsFast(spec, {}, signal) }
}
