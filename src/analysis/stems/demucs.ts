/**
 * HTDemucs four-stem separation (Défossez et al., facebookresearch/demucs, MIT) around an ONNX export whose STFT
 * and iSTFT run outside the graph (timcsy/demucs-web-onnx). Pre- and post-processing follow demucs 4
 * `HTDemucs._spec` / `_ispec` and `apply_model` (7.8 s segments, 25% overlap, triangular weights, no random
 * shifts), so results match the PyTorch reference.
 */
import { hannWindow, RealFFT } from '../dsp/fft.ts'
import { throwIfAborted } from '../dsp/stats.ts'

export const DEMUCS_SAMPLE_RATE = 44100
/** Model output order. */
export const DEMUCS_SOURCES = ['drums', 'bass', 'other', 'vocals'] as const
export type DemucsSource = (typeof DEMUCS_SOURCES)[number]
/** Samples per model segment (7.8 s). */
export const SEGMENT = 343980
const NFFT = 4096
const HOP = 1024
const BINS = NFFT / 2
const FRAMES = Math.ceil(SEGMENT / HOP)
const PAD = (HOP / 2) * 3
const OVERLAP = 0.25
const SOURCES = DEMUCS_SOURCES.length

/** One model segment. Shapes: mix [1, 2, SEGMENT], spec [1, 4, 2048, 336]; outputs x [1, 4, 4, 2048, 336], xt [1, 4, 2, SEGMENT]. */
export interface DemucsModel {
  run(mix: Float32Array, spec: Float32Array): Promise<{ x: Float32Array; xt: Float32Array }>
}

let fftCache: { fft: RealFFT; window: Float64Array } | undefined
const fftSetup = () => (fftCache ??= { fft: new RealFFT(NFFT), window: hannWindow(NFFT) })

function reflect(i: number, n: number): number {
  const period = 2 * (n - 1)
  let k = ((i % period) + period) % period
  if (k >= n) k = period - k
  return k
}

/**
 * Complex spectrogram of a stereo segment as demucs feeds it: reflect padding so frames align with the time
 * branch, centered torch.stft (normalized), last bin dropped, 2 edge frames trimmed. Layout [ch*2 + re/im][bin][frame].
 */
export function segmentSpectrogram(
  mix: Float32Array,
  spec = new Float32Array(4 * BINS * FRAMES),
): Float32Array {
  const { fft, window } = fftSetup()
  const padded = new Float64Array(SEGMENT + PAD + (PAD + FRAMES * HOP - SEGMENT))
  const centered = new Float64Array(padded.length + NFFT)
  const frame = new Float64Array(NFFT)
  const re = new Float64Array(fft.bins)
  const im = new Float64Array(fft.bins)
  const norm = 1 / Math.sqrt(NFFT)
  for (let ch = 0; ch < 2; ch++) {
    const x = mix.subarray(ch * SEGMENT, (ch + 1) * SEGMENT)
    for (let i = 0; i < padded.length; i++) padded[i] = x[reflect(i - PAD, SEGMENT)] as number
    for (let i = 0; i < centered.length; i++)
      centered[i] = padded[reflect(i - NFFT / 2, padded.length)] as number
    for (let f = 0; f < FRAMES; f++) {
      const start = (f + 2) * HOP
      for (let i = 0; i < NFFT; i++) frame[i] = (centered[start + i] as number) * (window[i] as number)
      fft.forward(frame, re, im)
      const reBase = ch * 2 * BINS * FRAMES
      const imBase = (ch * 2 + 1) * BINS * FRAMES
      for (let b = 0; b < BINS; b++) {
        spec[reBase + b * FRAMES + f] = (re[b] as number) * norm
        spec[imBase + b * FRAMES + f] = (im[b] as number) * norm
      }
    }
  }
  return spec
}

/**
 * Waveform of one source's frequency-branch output (demucs `_ispec`): zero Nyquist bin and 2 zero frames per side,
 * centered torch.istft (normalized), trimmed to the segment. Adds into `out` ([ch][SEGMENT]).
 */
export function addSourceWaveform(x: Float32Array, source: number, out: [Float32Array, Float32Array]): void {
  const { fft, window } = fftSetup()
  const frames = FRAMES + 4
  const length = (frames - 1) * HOP + NFFT
  const ola = new Float64Array(length)
  const envelope = new Float64Array(length)
  for (let f = 0; f < frames; f++)
    for (let i = 0; i < NFFT; i++) envelope[f * HOP + i] += (window[i] as number) ** 2
  const re = new Float64Array(fft.bins)
  const im = new Float64Array(fft.bins)
  const frame = new Float64Array(NFFT)
  const scale = Math.sqrt(NFFT)
  const offset = NFFT / 2 + PAD
  for (let ch = 0; ch < 2; ch++) {
    ola.fill(0)
    const reBase = (source * 4 + ch * 2) * BINS * FRAMES
    const imBase = reBase + BINS * FRAMES
    for (let f = 0; f < FRAMES; f++) {
      for (let b = 0; b < BINS; b++) {
        re[b] = (x[reBase + b * FRAMES + f] as number) * scale
        im[b] = (x[imBase + b * FRAMES + f] as number) * scale
      }
      // A real inverse FFT ignores the imaginary part of the DC and Nyquist bins.
      im[0] = 0
      re[BINS] = 0
      im[BINS] = 0
      fft.inverse(re, im, frame)
      const start = (f + 2) * HOP
      for (let i = 0; i < NFFT; i++) ola[start + i] += (frame[i] as number) * (window[i] as number)
    }
    const dst = out[ch]
    for (let i = 0; i < SEGMENT; i++) {
      const env = envelope[offset + i] as number
      dst[i] += env > 1e-11 ? (ola[offset + i] as number) / env : 0
    }
  }
}

export interface SeparateOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** Finalized stem audio from `start`: stems[source][channel], all the same length, in model source order. */
export type StemChunkHandler = (start: number, stems: Float32Array[][]) => void | Promise<void>

/**
 * Separates a 44.1 kHz song into drums, bass, other and vocals. Audio is emitted in order as soon as no later
 * segment overlaps it, so only about one segment of output is held in memory.
 */
export async function separateStems(
  model: DemucsModel,
  channels: readonly Float32Array[],
  emit: StemChunkHandler,
  options: SeparateOptions = {},
): Promise<void> {
  const left = channels[0]
  if (!left?.length) throw new RangeError('Audio has no samples')
  const right = channels[1] ?? left
  const n = left.length
  // demucs normalizes the whole track by the mono mix's mean and (unbiased) standard deviation.
  let sum = 0
  for (let i = 0; i < n; i++) sum += ((left[i] as number) + (right[i] as number)) / 2
  const mean = sum / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (((left[i] as number) + (right[i] as number)) / 2 - mean) ** 2
  const std = Math.sqrt(ss / Math.max(1, n - 1)) || 1

  const stride = Math.floor((1 - OVERLAP) * SEGMENT)
  const weight = new Float32Array(SEGMENT)
  const half = Math.floor(SEGMENT / 2)
  for (let i = 0; i < SEGMENT; i++) weight[i] = (i < half ? i + 1 : SEGMENT - i) / half
  const acc = Array.from({ length: SOURCES }, () => [new Float32Array(SEGMENT), new Float32Array(SEGMENT)])
  const wsum = new Float32Array(SEGMENT)
  const mix = new Float32Array(2 * SEGMENT)
  const spec = new Float32Array(4 * BINS * FRAMES)
  const offsets: number[] = []
  for (let o = 0; o < n; o += stride) offsets.push(o)
  let emitted = 0
  for (const [k, offset] of offsets.entries()) {
    throwIfAborted(options.signal)
    const chunk = Math.min(SEGMENT, n - offset)
    const lead = Math.floor((SEGMENT - chunk) / 2)
    const start = offset - lead
    for (let i = 0; i < SEGMENT; i++) {
      const j = start + i
      const inside = j >= 0 && j < n
      mix[i] = inside ? ((left[j] as number) - mean) / std : 0
      mix[SEGMENT + i] = inside ? ((right[j] as number) - mean) / std : 0
    }
    const { x, xt } = await model.run(mix, segmentSpectrogram(mix, spec))
    throwIfAborted(options.signal)
    const base = offset - emitted
    for (let s = 0; s < SOURCES; s++) {
      const wave: [Float32Array, Float32Array] = [
        xt.slice(s * 2 * SEGMENT, (s * 2 + 1) * SEGMENT),
        xt.slice((s * 2 + 1) * SEGMENT, (s * 2 + 2) * SEGMENT),
      ]
      addSourceWaveform(x, s, wave)
      for (let ch = 0; ch < 2; ch++) {
        const a = acc[s]?.[ch] as Float32Array
        const w = wave[ch]
        for (let i = 0; i < chunk; i++) a[base + i] += (weight[i] as number) * (w[lead + i] as number)
      }
    }
    for (let i = 0; i < chunk; i++) wsum[base + i] += weight[i] as number
    const until = k + 1 < offsets.length ? (offsets[k + 1] as number) : n
    const count = until - emitted
    const stems = acc.map((pair) =>
      pair.map((a) => {
        const out = new Float32Array(count)
        for (let i = 0; i < count; i++) out[i] = ((a[i] as number) / (wsum[i] as number)) * std + mean
        a.copyWithin(0, count)
        a.fill(0, SEGMENT - count)
        return out
      }),
    )
    wsum.copyWithin(0, count)
    wsum.fill(0, SEGMENT - count)
    await emit(emitted, stems)
    emitted = until
    options.onProgress?.((k + 1) / offsets.length)
  }
}
