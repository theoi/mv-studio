/** Word timing for lyrics by CTC forced alignment, plus helpers for re-aligning after manual edits. */
import type { LyricLine, LyricWord } from '../../model/types.ts'
import { newId } from '../../model/factory.ts'
import { type CtcEmissions, type Filler, forcedAlign } from './ctc.ts'
import { alignmentKey } from './text.ts'
import type { TimeRange } from './vad.ts'

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
  /**
   * Where someone sings (`voiceActivity` on the vocals stem). A token (a letter or the word delimiter) placed outside
   * costs `unvoicedCost` (log-probability per frame); blanks stay free. Separation leaves faint bleed in instrumental
   * stretches, which otherwise draws lines into a long instrumental ending or gap. A cost rather than a ban, so a quiet
   * line the detector misses can still be placed there.
   */
  voiced?: readonly TimeRange[]
  unvoicedCost?: number
  /**
   * Cost (log-probability per frame) of a pause between two words of the same line, so a line does not straddle a long
   * instrumental. Applies to lines of up to 24 words when the caller gives the line lengths.
   */
  linePause?: number
  /**
   * Singing the lyrics do not list (an unlisted intro or outro, ad-libs, a verse left out) may come before a line and
   * after the last one: each such stretch costs `unlistedEntry` and each of its frames `unlistedCost` (log-probability)
   * below the most likely letter there. Without it, such singing is unlikely to be blank, so the lyrics drift into it.
   * An infinite `unlistedCost` turns it off.
   */
  unlistedCost?: number
  unlistedEntry?: number
  /** Whether unlisted singing may come before the first word; not when it starts at `from` (a word dragged there). */
  unlistedBefore?: boolean
  /** When given, collects where the alignment took unlisted singing (seconds, in order). */
  unlistedFound?: TimeRange[]
}

const DEFAULT_MAX_HOLD = 0.6
/** Best of 0, 0.05 and 0.1 on the dev songs: word onsets within 0.3 s 88.3% -> 89.1%, mean error 0.49 -> 0.44 s. */
const DEFAULT_INTRA_WORD_PAUSE = 0.05
/*
 * With both on 21 dev songs: word onsets within 0.3 s 92.9% -> 94.5%, mean error 0.33 -> 0.11 s, words off by more
 * than 5 s 72 -> 7, and the same with a 40 s instrumental inserted mid-song or after the last line (without them:
 * 0.40 and 0.51 s). The line pause does most of it. An unvoiced cost of 2 to 8 does the same there; on the 24 songs
 * behind the README figures, 4 put one song's last lines 2 to 14 s early and 2 did not.
 */
const DEFAULT_UNVOICED_COST = 2
const DEFAULT_LINE_PAUSE = 0.1
/*
 * With a 30 s stretch of another song's vocals inserted between two lines mid-song or after the last line (24 dev
 * songs): words off by more than 5 s 920 -> 426 and 888 -> 551, and the songs as they are timed word for word as before.
 * Every entry cost from 100 to 150 with a frame cost from 0.075 to 0.15 keeps the songs as they are; below about 85,
 * one song's last stanza moves into the singing before it and its own place goes to the unlisted singing.
 */
const DEFAULT_UNLISTED_COST = 0.1
const DEFAULT_UNLISTED_ENTRY = 120
/** Longer "lines" are lyrics pasted without line breaks, where a pause between two words says nothing. */
const MAX_PAUSED_LINE_WORDS = 24

/**
 * Times for `words` (display text) sung in order within the range. Words without alignable letters are interpolated.
 * `lineLengths` (words per line, in order) lets pauses inside a line cost `linePause`.
 */
export function alignWords(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  words: readonly string[],
  options: AlignOptions = {},
  lineLengths?: readonly number[],
): LyricWord[] {
  const fs = em.frameSeconds
  const from = Math.max(0, Math.floor((options.from ?? 0) / fs))
  const to = Math.min(em.frames, Math.ceil((options.to ?? em.frames * fs) / fs))
  const tokens: number[] = []
  const ranges: ([number, number] | null)[] = []
  const pauseCost: number[] = []
  const intraWordPause = options.intraWordPause ?? DEFAULT_INTRA_WORD_PAUSE
  const linePause = options.linePause ?? DEFAULT_LINE_PAUSE
  // Words after the first of their line, in lines short enough for a pause inside them to mean something.
  const continuesLine = new Uint8Array(words.length)
  const startsLine = new Uint8Array(words.length)
  let lineStart = 0
  for (const n of lineLengths ?? []) {
    if (n <= MAX_PAUSED_LINE_WORDS) continuesLine.fill(1, lineStart + 1, lineStart + n)
    if (lineStart < words.length) startsLine[lineStart] = 1
    lineStart += n
  }
  // Blanks (before token k) where unlisted singing may go: before each line's first letter, and after the last.
  const unlistedAt: number[] = []
  let lineStarts = false
  for (const [i, word] of words.entries()) {
    const ids = [...alignmentKey(word)]
      .map((c) => vocab.ids[c])
      .filter((id): id is number => id !== undefined)
    lineStarts ||= startsLine[i] === 1
    if (ids.length === 0) {
      ranges.push(null)
      continue
    }
    const inLine = continuesLine[i] === 1 && tokens.length > 0
    if (inLine) pauseCost[tokens.length] = linePause
    if (tokens.length && vocab.wordDelimiter !== undefined) tokens.push(vocab.wordDelimiter)
    if (inLine) pauseCost[tokens.length] = linePause
    if (lineStarts) unlistedAt[tokens.length] = 1
    lineStarts = false
    ranges.push([tokens.length, tokens.length + ids.length])
    for (let k = 1; k < ids.length; k++) pauseCost[tokens.length + k] = intraWordPause
    tokens.push(...ids)
  }
  let unvoiced: Float32Array | undefined
  if (options.voiced) {
    unvoiced = new Float32Array(em.frames).fill(options.unvoicedCost ?? DEFAULT_UNVOICED_COST)
    for (const r of options.voiced)
      unvoiced.fill(0, Math.max(0, Math.floor(r.start / fs)), Math.ceil(r.end / fs))
  }
  unlistedAt[0] = options.unlistedBefore === false ? 0 : 1
  unlistedAt[tokens.length] = 1
  const unlistedCost = options.unlistedCost ?? DEFAULT_UNLISTED_COST
  const used: { start: number; end: number }[] = []
  const filler: Filler | undefined = Number.isFinite(unlistedCost)
    ? { at: unlistedAt, cost: unlistedCost, entry: options.unlistedEntry ?? DEFAULT_UNLISTED_ENTRY, used }
    : undefined
  const spans = forcedAlign(em, tokens, vocab.blank, from, to, pauseCost, unvoiced, filler)
  for (const u of used.reverse())
    options.unlistedFound?.push({ start: round(u.start * fs), end: round(u.end * fs) })
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
  const words = alignWords(
    em,
    vocab,
    split.flat(),
    options,
    split.map((s) => s.length),
  )
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
  const aligned = alignWords(
    em,
    vocab,
    tailWords,
    { ...options, from: time, unlistedBefore: false },
    tail.map((l) => l.words.length),
  )
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

/**
 * Re-aligns one line between the nearest timed lines around it, e.g. after its text was edited. Untimed lines in
 * between (pasted and never timed) do not bound it.
 */
export function realignLine(
  em: CtcEmissions,
  vocab: CtcVocabulary,
  lines: readonly LyricLine[],
  lineIndex: number,
  options: AlignOptions = {},
): LyricLine[] {
  const line = lines[lineIndex]
  if (!line) throw new RangeError('No such line')
  const from = lines.slice(0, lineIndex).findLast((l) => l.end !== undefined)?.end ?? options.from ?? 0
  const to =
    lines.slice(lineIndex + 1).find((l) => l.start !== undefined)?.start ??
    options.to ??
    em.frames * em.frameSeconds
  const [aligned] = alignLines(em, vocab, [line], { ...options, from, to })
  return lines.map((l, i) => (i === lineIndex && aligned ? aligned : l))
}
