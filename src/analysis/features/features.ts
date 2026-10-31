import type { AudioFeatures } from '../../model/types.ts'
import { DSP_BEAT_OFFSET } from '../beats/fast.ts'
import { quantile } from '../dsp/stats.ts'

/** Frame rate of stored audio features. The RMS windows (30-60 ms) carry nothing faster than this. */
export const FEATURE_RATE = 50
/** Band edges (Hz) for AudioFeatures.bands: sub, bass, low mids, mids, high mids, presence, brilliance. */
export const BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 4000, 6000, 11025]
export const BAND_LABELS = ['Sub bass', 'Bass', 'Low mids', 'Mids', 'High mids', 'Presence', 'Brilliance']

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function highpass(fs: number, f0: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w) / (2 * q)
  const c = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: (1 + c) / 2 / a0,
    b1: -(1 + c) / a0,
    b2: (1 + c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  }
}

function lowpass(fs: number, f0: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w) / (2 * q)
  const c = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: (1 - c) / 2 / a0,
    b1: (1 - c) / a0,
    b2: (1 - c) / 2 / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  }
}

function highShelf(fs: number, f0: number, gainDb: number, q: number): Biquad {
  const A = 10 ** (gainDb / 40)
  const w = (2 * Math.PI * f0) / fs
  const c = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const sq = 2 * Math.sqrt(A) * alpha
  const a0 = A + 1 - (A - 1) * c + sq
  return {
    b0: (A * (A + 1 + (A - 1) * c + sq)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * c)) / a0,
    b2: (A * (A + 1 + (A - 1) * c - sq)) / a0,
    a1: (2 * (A - 1 - (A + 1) * c)) / a0,
    a2: (A + 1 - (A - 1) * c - sq) / a0,
  }
}

function filter(x: Float32Array, chain: Biquad[]): Float32Array {
  let cur = x
  for (const f of chain) {
    const out = new Float32Array(cur.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < cur.length; i++) {
      const xi = cur[i]
      const y = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
      x2 = x1
      x1 = xi
      y2 = y1
      y1 = y
      out[i] = y
    }
    cur = out
  }
  return cur
}

function frameMeanSquare(
  x: Float32Array,
  fs: number,
  rate: number,
  frames: number,
  windowSec: number,
): Float64Array {
  const half = Math.max(1, Math.round((windowSec * fs) / 2))
  const out = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    const c = Math.round((f * fs) / rate)
    const a = Math.max(0, c - half)
    const z = Math.min(x.length, c + half)
    let s = 0
    for (let i = a; i < z; i++) s += x[i] * x[i]
    out[f] = z > a ? s / (z - a) : 0
  }
  return out
}

/** Below this reference level (dBFS mean square) a signal counts as silent. */
const SILENCE_DB = -70
/** Bands quieter than the loudest band by more than this keep their real level instead of full range. */
const BAND_SPAN_DB = 20

const toDb = (ms: Float64Array) => ms.map((v) => 10 * Math.log10(v + 1e-12))

/**
 * Maps dB to 0..1 over `rangeDb` below a reference: the signal's own loud level, but at least `minRefDb`.
 * Rounded for compact storage.
 */
function normalizeDb(db: Float64Array, rangeDb: number, minRefDb = SILENCE_DB): number[] {
  const ref = Math.max(quantile(db, 0.995), minRefDb)
  return Array.from(
    db,
    (v) => Math.round(Math.min(1, Math.max(0, (v - (ref - rangeDb)) / rangeDb)) * 1000) / 1000,
  )
}

/**
 * Onsets from an onset-strength curve: local maxima above an adaptive threshold, at least 50 ms apart.
 * `lag` compensates the curve peaking before the perceived onset, as for beats.
 */
export function pickOnsets(onset: Float32Array, fps: number, lag = DSP_BEAT_OFFSET): number[] {
  const n = onset.length
  const scale = quantile(onset, 0.99) || 1
  const pre = Math.round(0.1 * fps)
  const post = Math.round(0.03 * fps)
  const wait = Math.round(0.05 * fps)
  const times: number[] = []
  let last = -Infinity
  for (let i = 1; i < n - 1; i++) {
    let isMax = true
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (onset[k] > onset[i]) isMax = false
    if (!isMax) continue
    let m = 0
    let c = 0
    for (let k = Math.max(0, i - pre); k <= Math.min(n - 1, i + post); k++) {
      m += onset[k]
      c++
    }
    if (onset[i] < m / c + 0.07 * scale || i - last < wait) continue
    times.push(Math.round((i / fps + lag) * 1000) / 1000)
    last = i
  }
  return times
}

/**
 * Per-frame features of one mono signal (mix or stem) for audio-reactive effects. Every value is 0..1,
 * normalized to the signal's own loud level so effects react on quiet and loud songs alike.
 * `onset`/`onsetFps` is the spectral-flux onset curve of the same signal.
 */
export function computeAudioFeatures(
  mono: Float32Array,
  sampleRate: number,
  onset: Float32Array,
  onsetFps: number,
): AudioFeatures {
  const frames = Math.floor((mono.length / sampleRate) * FEATURE_RATE) + 1
  const nyq = sampleRate / 2
  // ITU-R BS.1770 K-weighting, approximated with RBJ biquads at the analysis rate.
  const k = filter(mono, [highShelf(sampleRate, 1681.97, 4, 0.7072), highpass(sampleRate, 38.135, 0.5003)])
  const loudness = normalizeDb(toDb(frameMeanSquare(k, sampleRate, FEATURE_RATE, frames, 0.05)), 36)
  const bandDb: Float64Array[] = []
  for (let b = 0; b + 1 < BAND_EDGES_HZ.length; b++) {
    const lo = BAND_EDGES_HZ[b]
    const hi = BAND_EDGES_HZ[b + 1]
    const chain: Biquad[] = [highpass(sampleRate, lo), highpass(sampleRate, lo)]
    if (hi < nyq * 0.98) chain.push(lowpass(sampleRate, hi), lowpass(sampleRate, hi))
    // Longer windows for low bands keep the envelope from rippling at the waveform period.
    const win = hi <= 250 ? 0.06 : 0.03
    bandDb.push(toDb(frameMeanSquare(filter(mono, chain), sampleRate, FEATURE_RATE, frames, win)))
  }
  const loudestBand = Math.max(...bandDb.map((db) => quantile(db, 0.995)))
  const bandColumns = bandDb.map((db) =>
    normalizeDb(db, 40, Math.max(SILENCE_DB, loudestBand - BAND_SPAN_DB)),
  )
  const bands = Array.from({ length: frames }, (_, f) => bandColumns.map((col) => col[f]))
  return {
    rate: FEATURE_RATE,
    loudness,
    bands,
    bandEdgesHz: [...BAND_EDGES_HZ],
    onsets: pickOnsets(onset, onsetFps),
  }
}
