/** Turns timed words (Whisper drafts, forced alignment, cloud transcription) into editable lyric lines. */
import { newId } from '../../model/factory.ts'
import type { Id, LyricLine, LyricsDoc, LyricWord, Seconds } from '../../model/types.ts'

export interface LineGroupingOptions {
  /** Times where a new line must start, e.g. transcription segment starts or section boundaries. */
  boundaries?: readonly Seconds[]
  /** A pause at least this long starts a new line. */
  maxGap?: Seconds
  /** Longer lines are split at their best pause or comma. */
  maxWords?: number
  /** Longer lines (seconds) are split at their best pause or comma. */
  maxDuration?: Seconds
}

export interface LyricsDocOptions extends LineGroupingOptions {
  audioAssetId?: Id
  source?: LyricsDoc['source']
}

const DEFAULT_MAX_GAP = 0.7
const DEFAULT_MAX_WORDS = 10
const DEFAULT_MAX_DURATION = 6
const SENTENCE_END = /[.!?…]["'”’)\]]*$/
const CLAUSE_END = /[,;:–—]["'”’)\]]*$/

const center = (w: LyricWord) => (w.start + w.end) / 2

function cleanWords(words: readonly LyricWord[]): LyricWord[] {
  return words
    .map((w) => ({ ...w, text: w.text.trim(), end: Math.max(w.start, w.end) }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start)
}

/** Splits an over-long run of words at the pause or clause end that best balances the two halves. */
function splitLong(words: LyricWord[], maxWords: number, maxDuration: number): LyricWord[][] {
  const n = words.length
  const duration = (words[n - 1] as LyricWord).end - (words[0] as LyricWord).start
  if (n < 2 || (n <= maxWords && duration <= maxDuration)) return [words]
  const minPart = n >= 4 ? 2 : 1
  let best = minPart
  let bestScore = -Infinity
  for (let k = minPart; k <= n - minPart; k++) {
    const prev = words[k - 1] as LyricWord
    const gap = (words[k] as LyricWord).start - prev.end
    const score = gap + (CLAUSE_END.test(prev.text) ? 0.3 : 0) - (0.4 * Math.abs(n - 2 * k)) / n
    if (score > bestScore) {
      bestScore = score
      best = k
    }
  }
  return [
    ...splitLong(words.slice(0, best), maxWords, maxDuration),
    ...splitLong(words.slice(best), maxWords, maxDuration),
  ]
}

/**
 * Groups timed words into lines: a new line starts at a boundary, after a pause of `maxGap` or after
 * sentence-ending punctuation; lines over `maxWords` or `maxDuration` are split at their best pause or comma.
 */
export function groupWordsIntoLines(
  words: readonly LyricWord[],
  options: LineGroupingOptions = {},
): LyricWord[][] {
  const maxGap = options.maxGap ?? DEFAULT_MAX_GAP
  const boundaries = [...(options.boundaries ?? [])].sort((a, b) => a - b)
  const sorted = cleanWords(words)
  const runs: LyricWord[][] = []
  let run: LyricWord[] = []
  let bi = 0
  for (const word of sorted) {
    const prev = run[run.length - 1]
    // A boundary belongs between two words when it falls between their centers, which tolerates the small
    // offsets between segment and word timestamps.
    let crossed = false
    while (bi < boundaries.length && (boundaries[bi] as number) <= center(word)) {
      if (prev && (boundaries[bi] as number) > center(prev)) crossed = true
      bi++
    }
    if (prev && (crossed || word.start - prev.end >= maxGap || SENTENCE_END.test(prev.text))) {
      runs.push(run)
      run = []
    }
    run.push(word)
  }
  if (run.length) runs.push(run)
  const maxWords = Math.max(1, options.maxWords ?? DEFAULT_MAX_WORDS)
  const maxDuration = options.maxDuration ?? DEFAULT_MAX_DURATION
  return runs.flatMap((r) => splitLong(r, maxWords, maxDuration))
}

/** A lyric line spanning its words. `words` must be non-empty and sorted by start. */
export function lineFromWords(words: LyricWord[], id: Id = newId()): LyricLine {
  return {
    id,
    text: words.map((w) => w.text).join(' '),
    start: words[0]?.start,
    end: words[words.length - 1]?.end,
    words,
  }
}

/** A lyrics document from timed words, grouped into lines with `groupWordsIntoLines`. */
export function toLyricsDoc(words: readonly LyricWord[], options: LyricsDocOptions = {}): LyricsDoc {
  const doc: LyricsDoc = {
    source: options.source ?? 'transcribed',
    lines: groupWordsIntoLines(words, options).map((line) => lineFromWords(line)),
  }
  if (options.audioAssetId !== undefined) doc.audioAssetId = options.audioAssetId
  return doc
}
