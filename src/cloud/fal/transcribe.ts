/**
 * Optional cloud transcription on fal.ai. Produces a draft (sung lyrics transcribe imperfectly) with word timings in
 * the project's LyricWord shape. Turn it into project lyrics with toLyricsDoc() from src/analysis/lyrics/doc.ts.
 */
import { groupWordsIntoLines, lineFromWords } from '../../analysis/lyrics/doc.ts'
import type { LyricWord } from '../../model/types.ts'
import type { TranscribedLine, TranscriptionResult } from '../types.ts'

export interface TranscriptionModelInfo {
  id: string
  name: string
  description: string
  usdPerMinute: number
  buildInput(o: { audioUrl: string; language?: string }): Record<string, unknown>
}

export const TRANSCRIPTION_MODELS: readonly TranscriptionModelInfo[] = [
  {
    id: 'fal-ai/elevenlabs/speech-to-text',
    name: 'ElevenLabs Scribe',
    description: 'Word-timed draft transcription. Works best on the separated vocals.',
    usdPerMinute: 0.03,
    buildInput: ({ audioUrl, language }) => ({
      audio_url: audioUrl,
      // Tags like "(music)" would become lyric words.
      tag_audio_events: false,
      diarize: false,
      ...(language ? { language_code: language } : {}),
    }),
  },
]

/** Shown before running cloud transcription. */
export const TRANSCRIPTION_NOTICE =
  'Cloud transcription is a draft: sung lyrics are often misheard, so check every line. It uploads the audio ' +
  '(the vocals stem when available) to fal.ai with your key.'

export function transcriptionModel(id?: string): TranscriptionModelInfo {
  return TRANSCRIPTION_MODELS.find((m) => m.id === id) ?? (TRANSCRIPTION_MODELS[0] as TranscriptionModelInfo)
}

export function parseTranscription(
  data: unknown,
): Omit<TranscriptionResult, 'modelId' | 'estimate'> | undefined {
  const d = data as { text?: unknown; language_code?: unknown; words?: unknown }
  if (!Array.isArray(d?.words)) return undefined
  const words: LyricWord[] = []
  for (const w of d.words as Record<string, unknown>[]) {
    if (typeof w !== 'object' || w === null) continue
    if (w.type !== undefined && w.type !== 'word') continue
    const text = typeof w.text === 'string' ? w.text.trim() : ''
    if (!text || typeof w.start !== 'number') continue
    const end = typeof w.end === 'number' && w.end >= w.start ? w.end : w.start + 0.2
    words.push({ text, start: w.start, end })
  }
  if (words.length === 0) return undefined
  words.sort((a, b) => a.start - b.start)
  return {
    text: typeof d.text === 'string' ? d.text : words.map((w) => w.text).join(' '),
    language: typeof d.language_code === 'string' ? d.language_code : undefined,
    words,
    lines: groupWordsIntoLines(words).map((group): TranscribedLine => {
      const line = lineFromWords(group)
      return { text: line.text, start: line.start ?? 0, end: line.end ?? 0, words: line.words }
    }),
  }
}
