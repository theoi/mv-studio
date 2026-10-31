import { describe, expect, it } from 'vitest'
import type { CtcVocabulary } from '../../../src/analysis/lyrics/align.ts'
import type { CtcEmissions } from '../../../src/analysis/lyrics/ctc.ts'
import { alignmentKey } from '../../../src/analysis/lyrics/text.ts'
import { planChunks, voiceActivity } from '../../../src/analysis/lyrics/vad.ts'
import {
  alignTranscript,
  cleanSegmentText,
  detectLanguage,
  transcribeChunks,
  type Transcriber,
} from '../../../src/analysis/lyrics/whisper.ts'

const SR = 16000

/** Noise bursts at the given [start, end) seconds over near silence. */
function bursts(seconds: number, ranges: [number, number][]): Float32Array {
  const pcm = new Float32Array(seconds * SR)
  let seed = 1
  for (let i = 0; i < pcm.length; i++) {
    seed = (seed * 16807) % 2147483647
    const t = i / SR
    const on = ranges.some(([a, b]) => t >= a && t < b)
    pcm[i] = ((seed / 2147483647) * 2 - 1) * (on ? 0.3 : 0.0003)
  }
  return pcm
}

describe('voiceActivity', () => {
  it('finds sung regions, bridges short pauses, drops blips and pads', () => {
    const pcm = bursts(20, [
      [1, 3],
      [3.3, 5],
      [9, 9.1],
      [12, 15],
    ])
    const regions = voiceActivity(pcm, SR, { pad: 0.1 })
    expect(regions).toHaveLength(2)
    expect(regions[0]?.start).toBeCloseTo(0.9, 1)
    expect(regions[0]?.end).toBeCloseTo(5.1, 1)
    expect(regions[1]?.start).toBeCloseTo(11.9, 1)
    expect(regions[1]?.end).toBeCloseTo(15.1, 1)
  })

  it('returns nothing for silence', () => {
    expect(voiceActivity(new Float32Array(SR * 2), SR)).toEqual([])
  })

  it('given the song, keeps singing 20 dB under it and drops bleed 27 dB under it', () => {
    /** Noise whose amplitude follows `level` (dB relative to the song) over 12 s. */
    const noise = (level: (t: number) => number, seed: number) => {
      const pcm = new Float32Array(12 * SR)
      for (let i = 0; i < pcm.length; i++) {
        seed = (seed * 16807) % 2147483647
        pcm[i] = ((seed / 2147483647) * 2 - 1) * 0.3 * 10 ** (level(i / SR) / 20)
      }
      return pcm
    }
    const song = noise(() => 0, 7)
    const vocals = noise(
      (t) => ((t >= 1 && t < 3) || (t >= 9 && t < 11) ? -20 : t >= 4 && t < 8 ? -27 : -70),
      1,
    )
    const edges = (regions: { start: number; end: number }[]) =>
      regions.map((r) => [Math.round(r.start * 10) / 10, Math.round(r.end * 10) / 10])
    expect(edges(voiceActivity(vocals, SR, { pad: 0, mix: song }))).toEqual([
      [1, 3],
      [9, 11],
    ])
    // Only 7 dB under the singing, the bleed passes the level test on its own.
    expect(edges(voiceActivity(vocals, SR, { pad: 0 }))).toEqual([
      [1, 3],
      [4, 8],
      [9, 11],
    ])
  })
})

describe('planChunks', () => {
  it('packs regions into chunks up to the limit and splits long regions evenly', () => {
    const chunks = planChunks(
      [
        { start: 0, end: 10 },
        { start: 12, end: 20 },
        { start: 25, end: 30 },
        { start: 40, end: 100 },
      ],
      28,
    )
    expect(chunks).toEqual([
      { start: 0, end: 20 },
      { start: 25, end: 30 },
      { start: 40, end: 60 },
      { start: 60, end: 80 },
      { start: 80, end: 100 },
    ])
  })
})

describe('cleanSegmentText', () => {
  it('removes annotations and stock captions', () => {
    expect(cleanSegmentText(' ♪ Hold on [Music] tight (x2) ♪')).toBe('Hold on tight')
    expect(cleanSegmentText('[Music]')).toBe('')
    expect(cleanSegmentText(' Thank you for watching!')).toBe('')
    expect(cleanSegmentText(' Thank you, baby')).toBe('Thank you, baby')
  })
})

/** A transcriber that returns scripted segments per call and records what it was given. */
function scripted(segments: { start: number; end: number; text: string }[][]) {
  const calls: { seconds: number; language?: string }[] = []
  const transcriber: Transcriber = {
    async transcribe(pcm, options) {
      calls.push({ seconds: pcm.length / SR, language: options.language })
      return segments[calls.length - 1] ?? []
    },
    languageProbabilities: async () => ({}),
  }
  return { transcriber, calls }
}

describe('transcribeChunks', () => {
  it('moves segment times into song time, clamps them to the chunk and drops empty segments', async () => {
    const { transcriber, calls } = scripted([
      [
        { start: 0.5, end: 2, text: ' We were young' },
        { start: 2, end: 3, text: ' [Music]' },
      ],
      [{ start: 1, end: 99, text: ' and the night was long' }],
    ])
    const chunks = [
      { start: 1, end: 5 },
      { start: 10, end: 14 },
    ]
    const segments = await transcribeChunks(transcriber, new Float32Array(20 * SR), chunks, {
      language: 'en',
    })
    expect(calls).toEqual([
      { seconds: 4, language: 'en' },
      { seconds: 4, language: 'en' },
    ])
    expect(segments).toEqual([
      { start: 1.5, end: 3, text: 'We were young', chunk: 0 },
      { start: 11, end: 14, text: 'and the night was long', chunk: 1 },
    ])
  })
})

describe('detectLanguage', () => {
  it('averages language probabilities over the longest chunks', async () => {
    // Each chunk's samples hold its index, so the model's answer reveals which chunk it heard.
    const chunks = [
      { start: 0, end: 1 },
      { start: 2, end: 10 },
      { start: 12, end: 20 },
    ]
    const pcm = new Float32Array(20 * SR)
    chunks.forEach((c, k) => pcm.fill(k, c.start * SR, c.end * SR))
    const answers: Record<number, Record<string, number>> = {
      0: { pt: 1 },
      1: { es: 0.6, ca: 0.4 },
      2: { es: 0.4, ca: 0.4, pt: 0.2 },
    }
    const transcriber: Transcriber = {
      transcribe: async () => [],
      languageProbabilities: async (clip) => answers[clip[0] as number] ?? {},
    }
    const result = await detectLanguage(transcriber, pcm, chunks, 2)
    expect(result.language).toBe('es')
    expect(result.probability).toBeCloseTo(0.5, 5)
  })
})
describe('alignTranscript', () => {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ'"
  const vocab: CtcVocabulary = {
    ids: Object.fromEntries([...LETTERS].map((c, i) => [c, i + 2])),
    blank: 0,
    wordDelimiter: 1,
  }
  const V = LETTERS.length + 2
  function sung(words: [string, number][], frames: number): CtcEmissions {
    const logProbs = new Float32Array(frames * V).fill(Math.log(0.1 / (V - 1)))
    const peaks: Record<number, number> = {}
    for (const [w, start] of words)
      [...alignmentKey(w)].forEach((c, k) => (peaks[start + 2 * k] = vocab.ids[c] as number))
    for (let f = 0; f < frames; f++) logProbs[f * V + (peaks[f] ?? 0)] = Math.log(0.9)
    return { logProbs, frames, vocab: V, frameSeconds: 0.02 }
  }

  it('times the words of each chunk within it and marks where each segment starts', () => {
    // "la" is sung at 1 s, 3 s and 7 s; the chunks hold one and two of them.
    const em = sung(
      [
        ['la', 50],
        ['la', 150],
        ['la', 350],
      ],
      500,
    )
    const chunks = [
      { start: 2, end: 4 },
      { start: 6, end: 9 },
    ]
    const { words, segmentStarts } = alignTranscript(
      em,
      vocab,
      [
        { start: 2, end: 4, text: 'La', chunk: 0 },
        { start: 6, end: 9, text: 'la', chunk: 1 },
      ],
      chunks,
    )
    expect(words.map((w) => w.start)).toEqual([3, 7])
    expect(segmentStarts).toEqual([3, 7])
  })

  it('leaves a word the aligner hears poorly where it is sung, with no unlisted singing in a draft', () => {
    // "yeah" is sung from 1 to 6 s, where the aligner mostly hears a Q, and "la" clearly at 8 s.
    const em = sung([['la', 400]], 500)
    for (let f = 50; f < 300; f++) {
      const row = f * V
      em.logProbs.fill(Math.log(0.45 / (V - 3)), row, row + V)
      em.logProbs[row + vocab.blank] = Math.log(0.001)
      em.logProbs[row + (vocab.ids.Q as number)] = Math.log(0.5)
      em.logProbs[row + (vocab.ids.Y as number)] = Math.log(0.05)
    }
    const { words } = alignTranscript(
      em,
      vocab,
      [{ start: 0, end: 10, text: 'yeah la', chunk: 0 }],
      [{ start: 0, end: 10 }],
    )
    // Unlisted singing would take nearly all of 1 to 6 s and push "yeah" to its end.
    expect(words.map((w) => w.start)).toEqual([1, 8])
  })
})
