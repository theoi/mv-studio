import type { LyricLine, LyricsDoc, LyricWord, Project } from '../../model/index.ts'
import { dispatch, editor, lyricLines } from './project.ts'
import { select, set } from './ui.ts'

/*
 * Lyric lines waiting for a look: every line drafted from the vocals (check 'words'), and timed lines whose words the
 * aligner could not place well (check 'timing'). A line stays to check until it is edited or marked as checked.
 */

/**
 * Words placed with less confidence than this are shown as uncertain (0: not placed at all). Measured on 24
 * JamendoLyrics songs, it flags about a third of a draft's words, 60% of them wrong, and catches half the wrong ones.
 */
export const UNCERTAIN_CONFIDENCE = 0.1

/**
 * A timed line is to check when the mean confidence of its words is below this, or two of its words start more than
 * TIMING_CHECK_GAP seconds apart. Measured on 24 JamendoLyrics songs: about 15% of lines are flagged, 69% of them with
 * a word more than 0.3 s off, and 65% of mostly-off lines are caught.
 */
export const TIMING_CHECK_CONFIDENCE = 0.1
export const TIMING_CHECK_GAP = 2

export const isUncertain = (word: LyricWord): boolean =>
  word.confidence !== undefined && word.confidence < UNCERTAIN_CONFIDENCE

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return sorted.length % 2
    ? (sorted[Math.floor(mid)] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

const confidences = (words: readonly LyricWord[]) =>
  words.map((w) => w.confidence).filter((c): c is number => c !== undefined)

/** True when the aligner placed the line's words poorly on average, or left a long gap inside the line. */
export function timingLooksUncertain(line: LyricLine): boolean {
  const scores = confidences(line.words)
  if (scores.length && scores.reduce((a, b) => a + b, 0) / scores.length < TIMING_CHECK_CONFIDENCE)
    return true
  return line.words.some(
    (w, i) => i > 0 && w.start - (line.words[i - 1] as LyricWord).start > TIMING_CHECK_GAP,
  )
}

/**
 * True when most of a draft is probably wrong: the median confidence of its words is below the uncertain mark. On the
 * measured songs such drafts had 9 to 34% of their words right (hard-to-hear vocals or the wrong language).
 */
export function draftLooksUnreliable(doc: LyricsDoc | undefined): boolean {
  const m = median(confidences((doc?.lines ?? []).flatMap((l) => l.words)))
  return m !== undefined && m < UNCERTAIN_CONFIDENCE
}

/** A transcription as stored: every line to check, with the language it was written in. */
export function asDraft(doc: LyricsDoc, language: string | undefined): LyricsDoc {
  return {
    ...doc,
    lines: doc.lines.map((l) => ({ ...l, check: 'words' as const })),
    ...(language ? { language } : {}),
  }
}

/** Timed lyrics as stored: the lines the aligner was unsure about are to check. */
export function withTimingChecks(doc: LyricsDoc): LyricsDoc {
  return {
    ...doc,
    lines: doc.lines.map((l) => (timingLooksUncertain(l) ? { ...l, check: 'timing' as const } : l)),
  }
}

/** What the current lyrics came from, for the result in Assist › Lyrics: a draft, aligner timing, or neither. */
export function lyricsResultKind(project: Project): 'draft' | 'timed' | null {
  const doc = project.lyrics
  if (!doc?.lines.length) return null
  if (doc.source === 'transcribed' || doc.source === 'mixed') return 'draft'
  return doc.lines.some((l) => confidences(l.words).length > 0) ? 'timed' : null
}

/** Lines to check, in order. */
export function linesToCheck(project: Project): LyricLine[] {
  return lyricLines(project).filter((l) => l.check)
}

export function markLineChecked(lineId: string): void {
  dispatch(
    { type: 'lyrics.updateLine', lineId, patch: { check: undefined } },
    { label: 'Mark line as checked' },
  )
}

export function markAllChecked(): void {
  const lines = linesToCheck(editor.getProject())
  if (!lines.length) return
  dispatch(
    lines.map((l) => ({ type: 'lyrics.updateLine' as const, lineId: l.id, patch: { check: undefined } })),
    { label: 'Mark all lines as checked' },
  )
}

/** Selects the first line to check and brings it into view on the timeline. */
export function showFirstToCheck(): void {
  const line = linesToCheck(editor.getProject())[0]
  if (!line) return
  select({ type: 'lyric', id: line.id })
  if (line.start !== undefined) set({ playhead: line.start })
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-lyric-line="${CSS.escape(line.id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' }),
  )
}

/** Languages Whisper takes as a hint (its multilingual models), by code. */
export const DRAFT_LANGUAGES = [
  'af',
  'am',
  'ar',
  'as',
  'az',
  'ba',
  'be',
  'bg',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fo',
  'fr',
  'gl',
  'gu',
  'ha',
  'haw',
  'he',
  'hi',
  'hr',
  'ht',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'jw',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'la',
  'lb',
  'ln',
  'lo',
  'lt',
  'lv',
  'mg',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'ne',
  'nl',
  'nn',
  'no',
  'oc',
  'pa',
  'pl',
  'ps',
  'pt',
  'ro',
  'ru',
  'sa',
  'sd',
  'si',
  'sk',
  'sl',
  'sn',
  'so',
  'sq',
  'sr',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'tk',
  'tl',
  'tr',
  'tt',
  'uk',
  'ur',
  'uz',
  'vi',
  'yi',
  'yo',
  'zh',
] as const

let names: Intl.DisplayNames | undefined

/** "Swedish" for 'sv'. Whisper writes Javanese as 'jw'. */
export function languageName(code: string): string {
  names ??= new Intl.DisplayNames(['en'], { type: 'language' })
  try {
    return names.of(code === 'jw' ? 'jv' : code) ?? code
  } catch {
    return code
  }
}
