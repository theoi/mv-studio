/**
 * Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024; MIT) preprocessing, windowed inference and
 * minimal peak picking, adapted from CPJKU/beat_this 1.1.0 and the @jgorset/beat-this port (MIT).
 * The ONNX session is injected so the same code runs on onnxruntime-web and onnxruntime-node.
 */
import { RealFFT } from '../dsp/fft.ts'
import { melFilterbank, type SparseFilter } from '../dsp/spectral.ts'
import { throwIfAborted } from '../dsp/stats.ts'

export const BEAT_THIS_SAMPLE_RATE = 22050
export const BEAT_THIS_HOP = 441
export const BEAT_THIS_FPS = BEAT_THIS_SAMPLE_RATE / BEAT_THIS_HOP // 50
const FFT_SIZE = 1024
const BANDS = 128
const CHUNK = 1500
const BORDER = 6

/** Runs one window of log-mel frames ([1, frames, 128]) and returns per-frame logits. */
export interface BeatThisModel {
  run(spect: Float32Array, frames: number): Promise<{ beat: Float32Array; downbeat: Float32Array }>
}

export interface BeatThisLogits {
  fps: number
  beat: Float32Array
  downbeat: Float32Array
}

let cached: { window: Float32Array; filters: SparseFilter[] } | null = null

function frontend(): { window: Float32Array; filters: SparseFilter[] } {
  if (!cached) {
    // torch.hann_window(1024) is evaluated in float32 upstream.
    const window = new Float32Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
      window[i] = Math.fround(0.5 - Math.fround(0.5 * Math.fround(Math.cos((2 * Math.PI * i) / FFT_SIZE))))
    }
    const filters = melFilterbank(BEAT_THIS_SAMPLE_RATE, FFT_SIZE, BANDS, 30, 11000, false)
    cached = { window, filters }
  }
  return cached
}

export function beatThisFrameCount(sampleCount: number): number {
  return Math.floor(sampleCount / BEAT_THIS_HOP) + 1
}

/** Log-mel features (frames x 128) for mono 22,050 Hz PCM, matching the upstream frontend. */
export function beatThisFeatures(
  pcm: Float32Array,
  first = 0,
  count = beatThisFrameCount(pcm.length),
): Float32Array {
  const { window, filters } = frontend()
  const total = pcm.length
  const fft = new RealFFT(FFT_SIZE)
  const buf = new Float64Array(FFT_SIZE)
  const re = new Float64Array(fft.bins)
  const im = new Float64Array(fft.bins)
  const mag = new Float64Array(fft.bins)
  const out = new Float32Array(count * BANDS)
  const norm = 1000 / Math.sqrt(FFT_SIZE)
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < FFT_SIZE; i++) {
      let idx = (first + f) * BEAT_THIS_HOP - FFT_SIZE / 2 + i
      if (idx < 0) idx = -idx
      if (idx >= total) idx = 2 * total - 2 - idx
      buf[i] = (idx >= 0 && idx < total ? pcm[idx] : 0) * window[i]
    }
    fft.forward(buf, re, im)
    for (let k = 0; k < fft.bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    for (let b = 0; b < BANDS; b++) {
      const flt = filters[b]
      let v = 0
      for (let j = 0; j < flt.weights.length; j++) v += mag[flt.start + j] * flt.weights[j]
      out[f * BANDS + b] = Math.log1p(norm * v)
    }
  }
  return out
}

export interface BeatThisRunOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** Runs the model over overlapping 30 s windows and stitches logits (upstream "keep_first"). */
export async function runBeatThis(
  model: BeatThisModel,
  pcm22k: Float32Array,
  options: BeatThisRunOptions = {},
): Promise<BeatThisLogits> {
  const frames = beatThisFrameCount(pcm22k.length)
  const features = beatThisFeatures(pcm22k)
  throwIfAborted(options.signal)
  const starts: number[] = []
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s)
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER)
  const beat = new Float32Array(frames).fill(-1000)
  const downbeat = new Float32Array(frames).fill(-1000)
  let writtenUntil = 0
  for (let n = 0; n < starts.length; n++) {
    throwIfAborted(options.signal)
    const start = starts[n]
    const first = Math.max(0, start)
    const stop = Math.min(start + CHUNK, frames)
    const left = Math.max(0, -start)
    const right = Math.max(0, Math.min(BORDER, start + CHUNK - frames))
    const count = stop - first + left + right
    const window = new Float32Array(count * BANDS)
    window.set(features.subarray(first * BANDS, stop * BANDS), left * BANDS)
    const result = await model.run(window, count)
    if (result.beat.length !== count || result.downbeat.length !== count) {
      throw new Error('Beat This! model returned an unexpected output length')
    }
    for (let i = Math.max(BORDER, writtenUntil - start); i < count - BORDER; i++) {
      beat[start + i] = result.beat[i]
      downbeat[start + i] = result.downbeat[i]
    }
    writtenUntil = Math.max(writtenUntil, start + count - BORDER)
    options.onProgress?.((n + 1) / starts.length)
  }
  return { fps: BEAT_THIS_FPS, beat, downbeat }
}

/** Upstream minimal postprocessor: positive 7-frame maxima with plateau merging, in seconds. */
export function beatThisPeaks(logits: Float32Array, fps = BEAT_THIS_FPS): number[] {
  const peaks: number[] = []
  for (let i = 0; i < logits.length; i++) {
    if (!(logits[i] > 0)) continue
    let max = true
    for (let j = Math.max(0, i - 3); j <= Math.min(logits.length - 1, i + 3); j++)
      if (logits[j] > logits[i]) max = false
    if (max) peaks.push(i)
  }
  const out: number[] = []
  for (let i = 0; i < peaks.length;) {
    let j = i + 1
    let m = peaks[i]
    while (j < peaks.length && peaks[j] - m <= 1) {
      m += (peaks[j] - m) / (j - i + 1)
      j++
    }
    let sum = 0
    for (let k = i; k < j; k++) sum += peaks[k]
    out.push(sum / (j - i) / fps)
    i = j
  }
  return out
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}
