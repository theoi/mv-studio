import { forEachPowerFrame, frameGrid, melFilterbank, applyFilter } from './dsp/spectral.ts'
import { throwIfAborted } from './dsp/stats.ts'

/** Analysis sample rate for the fast path (tempo, sections, features). */
export const ANALYSIS_SAMPLE_RATE = 22050
/** Frame rate of all fast-path frame data: frame i is centered at t = i / ANALYSIS_FPS. */
export const ANALYSIS_FPS = 100
const N_FFT = 2048
export const N_MELS = 64
const MEL_FMIN = 30
const MEL_FMAX = 11000
const CHROMA_FMIN = 60
const CHROMA_FMAX = 2200

/** Frequency bands (Hz) used for audio-reactive band features. */
export const FEATURE_BANDS: readonly { id: string; label: string; lo: number; hi: number }[] = [
  { id: 'sub', label: 'Sub bass', lo: 20, hi: 60 },
  { id: 'bass', label: 'Bass', lo: 60, hi: 250 },
  { id: 'lowMid', label: 'Low mids', lo: 250, hi: 500 },
  { id: 'mid', label: 'Mids', lo: 500, hi: 2000 },
  { id: 'highMid', label: 'High mids', lo: 2000, hi: 4000 },
  { id: 'presence', label: 'Presence', lo: 4000, hi: 6000 },
  { id: 'brilliance', label: 'Brilliance', lo: 6000, hi: 11025 },
]

export interface SpectralAnalysis {
  sampleRate: number
  fps: number
  frames: number
  duration: number
  nMels: number
  /** frames x nMels log-mel power in dB. */
  melDb: Float32Array
  /** frames x 12 chroma energy (C, C#, ... B), unnormalized magnitude sums. */
  chroma: Float32Array
  /** frames x FEATURE_BANDS.length band power (linear, |X|^2 sums). */
  bandPower: Float32Array
  /** Spectral centroid in Hz per frame. */
  centroid: Float32Array
}

export function analyzeSpectrum(
  mono: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
): SpectralAnalysis {
  const grid = frameGrid(mono.length, sampleRate, ANALYSIS_FPS)
  const filters = melFilterbank(sampleRate, N_FFT, N_MELS, MEL_FMIN, Math.min(MEL_FMAX, sampleRate / 2))
  const bins = N_FFT / 2 + 1
  const binHz = sampleRate / N_FFT
  const pcOf = new Int8Array(bins).fill(-1)
  for (let k = 1; k < bins; k++) {
    const f = k * binHz
    if (f < CHROMA_FMIN || f > CHROMA_FMAX) continue
    const midi = 69 + 12 * Math.log2(f / 440)
    pcOf[k] = ((Math.round(midi) % 12) + 12) % 12
  }
  const bandOf = new Int8Array(bins).fill(-1)
  for (let k = 1; k < bins; k++) {
    const f = k * binHz
    const b = FEATURE_BANDS.findIndex((band) => f >= band.lo && f < band.hi)
    bandOf[k] = b
  }
  const nb = FEATURE_BANDS.length
  const melDb = new Float32Array(grid.frames * N_MELS)
  const chroma = new Float32Array(grid.frames * 12)
  const bandPower = new Float32Array(grid.frames * nb)
  const centroid = new Float32Array(grid.frames)
  forEachPowerFrame(mono, grid, N_FFT, (f, power) => {
    if ((f & 1023) === 0) throwIfAborted(signal)
    for (let m = 0; m < N_MELS; m++)
      melDb[f * N_MELS + m] = 10 * Math.log10(applyFilter(filters[m], power) + 1e-10)
    let num = 0
    let den = 0
    for (let k = 1; k < bins; k++) {
      const p = power[k]
      const pc = pcOf[k]
      if (pc >= 0) chroma[f * 12 + pc] += Math.sqrt(p)
      const b = bandOf[k]
      if (b >= 0) bandPower[f * nb + b] += p
      num += k * binHz * p
      den += p
    }
    centroid[f] = den > 0 ? num / den : 0
  })
  return {
    sampleRate,
    fps: ANALYSIS_FPS,
    frames: grid.frames,
    duration: mono.length / sampleRate,
    nMels: N_MELS,
    melDb,
    chroma,
    bandPower,
    centroid,
  }
}
