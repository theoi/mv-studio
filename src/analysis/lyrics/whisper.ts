/** Draft lyrics from speech recognition: chunked transcription of sung regions, then word timing by CTC alignment. */
import type { LyricWord } from '../../model/types.ts'
import { throwIfAborted } from '../dsp/stats.ts'
import { type AlignOptions, alignWords, type CtcVocabulary } from './align.ts'
import type { CtcEmissions } from './ctc.ts'
import { CTC_SAMPLE_RATE } from './wav2vec2.ts'
import type { TimeRange } from './vad.ts'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** A speech model working on up to 30 s of 16 kHz mono audio. */
export interface Transcriber {
  /** Segment times are relative to the start of `pcm`. */
  transcribe(pcm: Float32Array, options: { language?: string }): Promise<TranscriptSegment[]>
  /** Probability of each language code the model knows. */
  languageProbabilities(pcm: Float32Array): Promise<Record<string, number>>
}

export interface TranscribeOptions {
  /** Whisper language code, e.g. 'en'. Detected per chunk when omitted. */
  language?: string
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** Annotations speech models add for non-speech, e.g. "[Music]", "(upbeat music)", "♪". */
const ANNOTATION = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g
/** Captions Whisper learned from video subtitles and produces over music or silence. */
const STOCK_PHRASES = [
  /^thanks? (you )?(so much )?for watching/i,
  /^please subscribe/i,
  /^subtitles? (by|made by|created by)/i,
  /^(transcribed|translated|captions?) by/i,
  /^(thank you|you|bye)[.!]*$/i,
]

/** Segment text without annotations, or '' when nothing sung remains. */
export function cleanSegmentText(text: string): string {
  const cleaned = text.replace(ANNOTATION, ' ').replace(/\s+/g, ' ').trim()
  if (!/\p{L}/u.test(cleaned) || STOCK_PHRASES.some((p) => p.test(cleaned))) return ''
  return cleaned
}

/**
 * The song's language, from the average language probabilities of its longest chunks. Detecting once keeps the
 * model from switching language between chunks.
 */
export async function detectLanguage(
  transcriber: Transcriber,
  pcm: Float32Array,
  chunks: readonly TimeRange[],
  maxChunks = 3,
): Promise<{ language: string; probability: number }> {
  const longest = [...chunks].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, maxChunks)
  const total: Record<string, number> = {}
  for (const c of longest) {
    const clip = pcm.slice(Math.round(c.start * CTC_SAMPLE_RATE), Math.round(c.end * CTC_SAMPLE_RATE))
    for (const [language, p] of Object.entries(await transcriber.languageProbabilities(clip)))
      total[language] = (total[language] ?? 0) + p / longest.length
  }
  const [language, probability] = Object.entries(total).sort((a, b) => b[1] - a[1])[0] ?? ['en', 0]
  return { language, probability }
}

/** Transcribes each chunk of `pcm` (16 kHz mono) and returns cleaned segments in song time. */
export async function transcribeChunks(
  transcriber: Transcriber,
  pcm: Float32Array,
  chunks: readonly TimeRange[],
  options: TranscribeOptions = {},
): Promise<(TranscriptSegment & { chunk: number })[]> {
  const out: (TranscriptSegment & { chunk: number })[] = []
  for (const [k, chunk] of chunks.entries()) {
    throwIfAborted(options.signal)
    const a = Math.max(0, Math.round(chunk.start * CTC_SAMPLE_RATE))
    const b = Math.min(pcm.length, Math.round(chunk.end * CTC_SAMPLE_RATE))
    if (b - a < CTC_SAMPLE_RATE / 4) continue
    const segments = await transcriber.transcribe(pcm.slice(a, b), { language: options.language })
    for (const s of segments) {
      const text = cleanSegmentText(s.text)
      if (!text) continue
      const start = Math.min(chunk.end, chunk.start + Math.max(0, s.start))
      const end = Math.min(chunk.end, Math.max(start, chunk.start + (Number.isFinite(s.end) ? s.end : b - a)))
      out.push({ start, end, text, chunk: k })
    }
    options.onProgress?.((k + 1) / chunks.length)
  }
  return out
}

export interface TimedTranscript {
  words: LyricWord[]
  /** Start of each transcript segment's first word, for line breaks. */
  segmentStarts: number[]
}

/**
 * Word timings for transcript segments. The words of each chunk are aligned within the chunk, which tolerates the
 * loose segment timestamps speech models produce on singing.
 */
export function alignTranscript(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  segments: readonly (TranscriptSegment & { chunk: number })[],
  chunks: readonly TimeRange[],
  options: Pick<AlignOptions, 'maxHold'> = {},
): TimedTranscript {
  const words: LyricWord[] = []
  const segmentStarts: number[] = []
  for (const [k, chunk] of chunks.entries()) {
    const own = segments.filter((s) => s.chunk === k)
    if (own.length === 0) continue
    const split = own.map((s) => s.text.split(/\s+/).filter(Boolean))
    const timed = alignWords(em, vocab, split.flat(), { ...options, from: chunk.start, to: chunk.end })
    let i = 0
    for (const segWords of split) {
      if (segWords.length && timed[i]) segmentStarts.push((timed[i] as LyricWord).start)
      i += segWords.length
    }
    words.push(...timed)
  }
  return { words, segmentStarts }
}
