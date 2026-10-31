/** Character CTC emissions from a wav2vec2-style model over a whole song, in overlapping windows. */
import { throwIfAborted } from '../dsp/stats.ts'
import { type CtcEmissions, logSoftmaxRows } from './ctc.ts'

export const CTC_SAMPLE_RATE = 16000
/** wav2vec2's convolutional front end: one frame per 320 samples (20 ms). */
const HOP = 320

/** Runs one window of normalized 16 kHz audio and returns frame-major logits. */
export interface CtcModel {
  run(input: Float32Array): Promise<{ logits: Float32Array; frames: number; vocab: number }>
}

export interface EmissionOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  windowSeconds?: number
  overlapSeconds?: number
}

/**
 * Log-probabilities for every 20 ms frame of `pcm` (16 kHz mono). Windows overlap and only their centers are
 * kept, so frames near window edges still see context on both sides.
 */
export async function ctcEmissions(
  model: CtcModel,
  pcm: Float32Array,
  options: EmissionOptions = {},
): Promise<CtcEmissions> {
  const win = Math.round(((options.windowSeconds ?? 30) * CTC_SAMPLE_RATE) / HOP) * HOP
  const overlap = Math.round(((options.overlapSeconds ?? 2) * CTC_SAMPLE_RATE) / HOP) * HOP
  const step = win - 2 * overlap
  const totalFrames = Math.floor(pcm.length / HOP)
  const starts: number[] = []
  for (let s = 0; s === 0 || s + overlap * 2 < pcm.length; s += step) starts.push(s)
  let out: Float32Array | undefined
  let vocab = 0
  for (const [k, start] of starts.entries()) {
    throwIfAborted(options.signal)
    const chunk = pcm.subarray(start, Math.min(pcm.length, start + win))
    let mean = 0
    for (let i = 0; i < chunk.length; i++) mean += chunk[i] as number
    mean /= chunk.length || 1
    let variance = 0
    for (let i = 0; i < chunk.length; i++) variance += ((chunk[i] as number) - mean) ** 2
    variance /= chunk.length || 1
    // Same normalization as the Hugging Face feature extractor (zero mean, unit variance).
    const scale = 1 / Math.sqrt(variance + 1e-7)
    const input = Float32Array.from(chunk, (v) => (v - mean) * scale)
    const result = await model.run(input)
    vocab = result.vocab
    out ??= new Float32Array(totalFrames * vocab)
    const first = start / HOP
    const keepFrom = k === 0 ? 0 : overlap / HOP
    const keepTo = k === starts.length - 1 ? result.frames : result.frames - overlap / HOP
    for (let f = keepFrom; f < keepTo && first + f < totalFrames; f++)
      out.set(result.logits.subarray(f * vocab, (f + 1) * vocab), (first + f) * vocab)
    options.onProgress?.((k + 1) / starts.length)
  }
  return {
    logProbs: logSoftmaxRows(out ?? new Float32Array(0), vocab),
    frames: totalFrames,
    vocab,
    frameSeconds: HOP / CTC_SAMPLE_RATE,
  }
}
