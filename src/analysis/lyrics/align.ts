/** Word timing for lyrics by CTC forced alignment, plus helpers for re-aligning after manual edits. */
import type { LyricLine, LyricWord } from '../../model/types.ts'
import { newId } from '../../model/factory.ts'
import { type CtcEmissions, forcedAlign } from './ctc.ts'
import { alignmentKey } from './text.ts'

export interface CtcVocabulary {
  /** Token id per character (A-Z and apostrophe). */
  ids: Record<string, number>
  blank: number
  /** Token emitted between words, if the model has one (wav2vec2: '|'). */
  wordDelimiter?: number
}

/** The vocabulary of a wav2vec2 tokenizer's vocab.json: characters, '<pad>' as blank and '|' between words. */
export function ctcVocabulary(tokens: Record<string, number>): CtcVocabulary {
  const blank = tokens['<pad>']
  if (blank === undefined) throw new Error('CTC vocabulary has no <pad> token')
  const ids: Record<string, number> = {}
  for (const [token, id] of Object.entries(tokens)) if (/^[A-Z']$/.test(token)) ids[token] = id
  return { ids, blank, wordDelimiter: tokens['|'] }
}

export interface AlignOptions {
  /** Time range (seconds) the words are sung in; defaults to the whole song. */
  from?: number
  to?: number
  /** Longest a word is held after its last character, unless the next word starts sooner (seconds). */
  maxHold?: number
  /**
   * Cost (log-probability per frame) of a pause between two characters of the same word. Without it, the first
   * letter of a line can lock onto a stray sound (an ad-lib, a breath) long before the line is sung.
   */
  intraWordPause?: number
}

const DEFAULT_MAX_HOLD = 0.6
/** Best of 0, 0.05 and 0.1 on the dev songs: word onsets within 0.3 s 88.3% -> 89.1%, mean error 0.49 -> 0.44 s. */
const DEFAULT_INTRA_WORD_PAUSE = 0.05

/** Times for `words` (display text) sung in order within the range. Words without alignable letters are interpolated. */
export function alignWords(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  words: readonly string[],
  options: AlignOptions = {},
): LyricWord[] {
  const fs = em.frameSeconds
  const from = Math.max(0, Math.floor((options.from ?? 0) / fs))
  const to = Math.min(em.frames, Math.ceil((options.to ?? em.frames * fs) / fs))
  const tokens: number[] = []
  const ranges: ([number, number] | null)[] = []
  const pauseCost: number[] = []
  const intraWordPause = options.intraWordPause ?? DEFAULT_INTRA_WORD_PAUSE
  for (const word of words) {
    const ids = [...alignmentKey(word)]
      .map((c) => vocab.ids[c])
      .filter((id): id is number => id !== undefined)
    if (ids.length === 0) {
      ranges.push(null)
      continue
    }
    if (tokens.length && vocab.wordDelimiter !== undefined) tokens.push(vocab.wordDelimiter)
    ranges.push([tokens.length, tokens.length + ids.length])
    for (let k = 1; k < ids.length; k++) pauseCost[tokens.length + k] = intraWordPause
    tokens.push(...ids)
  }
  const spans = forcedAlign(em, tokens, vocab.blank, from, to, pauseCost)
  const timed: (LyricWord | null)[] = words.map((text, i) => {
    const r = ranges[i]
    if (!spans || !r) return null
    const first = spans[r[0]]
    const last = spans[r[1] - 1]
    if (!first || !last) return null
    let score = 0
    for (let k = r[0]; k < r[1]; k++) score += (spans[k] as { score: number }).score
    return { text, start: first.start * fs, end: last.end * fs, confidence: round(score / (r[1] - r[0])) }
  })
  return finishWords(words, timed, from * fs, to * fs, options.maxHold ?? DEFAULT_MAX_HOLD)
}

const round = (v: number) => Math.round(v * 1000) / 1000

/** Holds each word until the next one (up to maxHold) and spreads untimed words over the gaps around them. */
function finishWords(
  words: readonly string[],
  timed: (LyricWord | null)[],
  rangeStart: number,
  rangeEnd: number,
  maxHold: number,
): LyricWord[] {
  const out: LyricWord[] = []
  let i = 0
  while (i < words.length) {
    const w = timed[i]
    if (w) {
      const next = timed.slice(i + 1).find((x): x is LyricWord => x !== null)
      const limit = next ? next.start : rangeEnd
      out.push({ ...w, start: round(w.start), end: round(Math.max(w.end, Math.min(limit, w.end + maxHold))) })
      i++
      continue
    }
    // A run of untimed words between the previous word's end and the next timed word's start.
    let j = i
    while (j < words.length && !timed[j]) j++
    const a = out.at(-1)?.end ?? rangeStart
    const b = timed[j]?.start ?? rangeEnd
    const n = j - i
    for (let k = 0; k < n; k++)
      out.push({
        text: words[i + k] as string,
        start: round(a + ((b - a) * k) / n),
        end: round(a + ((b - a) * (k + 1)) / n),
        confidence: 0,
      })
    i = j
  }
  return out
}

/** Lines as text, aligned together so the whole song constrains every line. Keeps given line ids. */
export function alignLines(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  lines: readonly { id?: string; text: string }[],
  options: AlignOptions = {},
): LyricLine[] {
  const split = lines.map((l) => l.text.split(/\s+/).filter(Boolean))
  const words = alignWords(em, vocab, split.flat(), options)
  let k = 0
  return lines.map((line, i) => {
    const own = words.slice(k, k + (split[i] as string[]).length)
    k += own.length
    return {
      id: line.id ?? newId(),
      text: line.text,
      start: own[0]?.start,
      end: own.at(-1)?.end,
      words: own,
    }
  })
}

/**
 * Re-aligns everything from word `wordIndex` of line `lineIndex` onward, with that word pinned to start at `time`.
 * Earlier words keep their timing. Use after the user drags a word to its correct position.
 */
export function realignFrom(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  lines: readonly LyricLine[],
  lineIndex: number,
  wordIndex: number,
  time: number,
  options: AlignOptions = {},
): LyricLine[] {
  const line = lines[lineIndex]
  if (!line || wordIndex < 0 || wordIndex >= line.words.length) throw new RangeError('No such word')
  const tail = [
    { id: line.id, text: '', words: line.words.slice(wordIndex) },
    ...lines.slice(lineIndex + 1).map((l) => ({ id: l.id, text: l.text, words: l.words })),
  ]
  const tailWords = tail.flatMap((l) => l.words.map((w) => w.text))
  const aligned = alignWords(em, vocab, tailWords, { ...options, from: time })
  if (aligned[0]) aligned[0] = { ...aligned[0], start: round(time) }
  let k = 0
  const retimed = tail.map((l) => {
    const own = aligned.slice(k, k + l.words.length)
    k += own.length
    return own
  })
  return lines.map((l, i) => {
    if (i < lineIndex) return l
    const words =
      i === lineIndex
        ? [...l.words.slice(0, wordIndex), ...(retimed[0] ?? [])]
        : (retimed[i - lineIndex] ?? [])
    return { ...l, words, start: words[0]?.start, end: words.at(-1)?.end }
  })
}

/** Re-aligns one line between its neighbours, e.g. after its text was edited. */
export function realignLine(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  lines: readonly LyricLine[],
  lineIndex: number,
  options: AlignOptions = {},
): LyricLine[] {
  const line = lines[lineIndex]
  if (!line) throw new RangeError('No such line')
  const from = lines[lineIndex - 1]?.end ?? options.from ?? 0
  const to = lines[lineIndex + 1]?.start ?? options.to ?? em.frames * em.frameSeconds
  const [aligned] = alignLines(em, vocab, [line], { ...options, from, to })
  return lines.map((l, i) => (i === lineIndex && aligned ? aligned : l))
}
