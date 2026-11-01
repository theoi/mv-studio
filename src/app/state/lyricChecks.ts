import type { LyricLine, LyricsDoc, LyricWord, Project } from '../../model/index.ts'
import { dispatch, editor, lyricLines } from './project.ts'
import { get, select, set, useUi } from './ui.ts'

/*
 * Lyric lines waiting for a look: every line drafted from the vocals (check 'words'), timed lines near singing the
 * pasted lyrics do not list (check 'unlisted'), and other timed lines whose words the aligner could not place well
 * (check 'timing'). A line stays to check until it is edited or marked as checked.
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

/**
 * A timed line is to check for unlisted singing when it is within UNLISTED_CHECK_NEAR seconds of a stretch the aligner
 * took as singing the lyrics do not list, of at least UNLISTED_CHECK_MIN seconds. With 15 to 60 s of another song's
 * singing inserted mid-song or after the last line of 24 JamendoLyrics songs, the lines to check then hold 37 to 71% of
 * the words placed more than 5 s off, against 26 to 45% by the timing check alone. The songs as they are have no such
 * stretch. Any minimum from 0 to 12 s flags the same lines there; 4 s guards against short ad-libs.
 */
export const UNLISTED_CHECK_NEAR = 10
export const UNLISTED_CHECK_MIN = 4

type Stretch = { start: number; end: number }

/**
 * The stretches of unlisted singing (seconds, from the aligner) that lines are checked for and timed lyrics keep
 * (`LyricsDoc.unlisted`): rounded to 0.01 s, merged where they overlap or touch, in order, and at least
 * UNLISTED_CHECK_MIN seconds long.
 */
export function longUnlisted(unlisted: readonly Stretch[]): Stretch[] {
  const cs = (t: number) => Math.round(t * 100)
  const merged: Stretch[] = []
  for (const u of unlisted
    .map((u) => ({ start: cs(u.start), end: cs(u.end) }))
    .sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && u.start <= last.end) last.end = Math.max(last.end, u.end)
    else merged.push(u)
  }
  return merged
    .filter((u) => u.end - u.start >= UNLISTED_CHECK_MIN * 100)
    .map((u) => ({ start: u.start / 100, end: u.end / 100 }))
}

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

/**
 * Timed lyrics as stored: the lines near `unlisted` singing (seconds, from the aligner) and the lines the aligner was
 * unsure about are to check, each line for one reason.
 */
export function withTimingChecks(doc: LyricsDoc, unlisted: readonly Stretch[] = []): LyricsDoc {
  const long = longUnlisted(unlisted)
  const nearUnlisted = ({ start, end }: LyricLine) =>
    start !== undefined &&
    end !== undefined &&
    long.some((u) => end >= u.start - UNLISTED_CHECK_NEAR && start <= u.end + UNLISTED_CHECK_NEAR)
  return {
    ...doc,
    lines: doc.lines.map((l) =>
      nearUnlisted(l)
        ? { ...l, check: 'unlisted' as const }
        : timingLooksUncertain(l)
          ? { ...l, check: 'timing' as const }
          : l,
    ),
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

/** The line to check after line `afterId` in singing order, or the first one when none comes after it. */
export function nextToCheck(project: Project, afterId?: string): LyricLine | undefined {
  const lines = lyricLines(project)
  const from = afterId === undefined ? -1 : lines.findIndex((l) => l.id === afterId)
  return lines.slice(from + 1).find((l) => l.check) ?? lines.find((l) => l.check)
}

/** The selected lyric line, if a lyric line is selected. */
export function selectedLyricLine(): string | undefined {
  const s = get().selection
  return s.type === 'lyric' ? s.id : undefined
}

/**
 * Selects the line to check after the selected lyric line (the first one when no line is selected, and again from
 * the first after the last) and brings it into view on the timeline, with the playhead at its start.
 */
export function showNextToCheck(): void {
  const line = nextToCheck(editor.getProject(), selectedLyricLine())
  if (!line) return
  select({ type: 'lyric', id: line.id })
  if (line.start !== undefined) {
    stopPlayingLine?.()
    set({ playhead: line.start })
  }
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-lyric-line="${CSS.escape(line.id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' }),
  )
}

/** Moves the playhead to a lyric line's start, unless it is inside the line already, so Play plays that line. */
export function playheadToLine(lineId: string): void {
  const line = lyricLines(editor.getProject()).find((l) => l.id === lineId)
  if (line?.start === undefined) return
  const t = get().playhead
  if (t >= line.start && t < (line.end ?? line.start)) return
  stopPlayingLine?.()
  set({ playhead: line.start })
}

/** How long Play line goes on past the line's end, so its last word is heard out. */
export const PLAY_LINE_TAIL = 0.5
/** Play line starts watching for the line's end once a frame shows playback within this long of its start (s). */
const PLAY_LINE_ARM = 0.5
/**
 * How far a playhead step may differ from the time that passed and still be playback (s). Playback runs at 1×, so a
 * late frame (a stall, or a hidden tab while the audio plays on) is a long step that is still playback; a seek is not.
 * The preview takes a frame's time before drawing it and reports it after, so one slow draw (a clip to decode at a
 * cut) moves a step this far off on its own. Moving the playhead to a line stops the watcher itself.
 */
const PLAY_DRIFT = 0.3
/** Play line stops waiting for playback from the line's start after this long once the preview has started (s). */
const PLAY_LINE_WAIT = 1
let stopPlayingLine: (() => void) | undefined

/**
 * Plays a lyric line from its start and pauses as playback passes just after its end. Pausing, seeking, or playing
 * another line before then leaves playback as it is.
 */
export function playLine(lineId: string): void {
  const line = lyricLines(editor.getProject()).find((l) => l.id === lineId)
  if (line?.start === undefined || line.end === undefined) return
  const start = line.start
  stopPlayingLine?.()
  const end = line.end + PLAY_LINE_TAIL
  // Playing from the click itself, so the browser lets audio start.
  set({ playhead: start, playing: true })
  /** The last frame of playback from the line's start, once there is one, and when it came (ms). */
  let last: { t: number; at: number } | undefined
  /** Since when the preview has played without playback from the line's start (ms). */
  let waitingSince = get().starting ? undefined : performance.now()
  let unsubscribe = () => {}
  const stop = () => {
    unsubscribe()
    if (stopPlayingLine === stop) stopPlayingLine = undefined
  }
  unsubscribe = useUi.subscribe((s, prev) => {
    if (!s.playing) return stop()
    if (s.starting) {
      waitingSince = undefined
      return
    }
    const now = performance.now()
    waitingSince ??= now
    if (s.playhead === prev.playhead) return
    if (last && Math.abs(s.playhead - last.t - (now - last.at) / 1000) <= PLAY_DRIFT) {
      if (last.t < end && s.playhead >= end) {
        stop()
        set({ playing: false })
        return
      }
      last = { t: s.playhead, at: now }
      return
    }
    // Not playback on from the last frame: playback from the line's start (again), a frame from before the seek to
    // it (the preview reports one after playback starts), or a seek elsewhere.
    if (s.playhead >= start && s.playhead <= start + PLAY_LINE_ARM) last = { t: s.playhead, at: now }
    else if (last || now - waitingSince > PLAY_LINE_WAIT * 1000) stop()
  })
  stopPlayingLine = stop
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
