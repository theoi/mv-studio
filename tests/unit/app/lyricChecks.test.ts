import { afterEach, describe, expect, it } from 'vitest'
import type { LyricLine, LyricsDoc, Project } from '../../../src/model/index.ts'
import { createProject } from '../../../src/model/factory.ts'
import {
  asDraft,
  draftLooksUnreliable,
  isUncertain,
  languageName,
  longUnlisted,
  nextToCheck,
  PLAY_LINE_TAIL,
  playheadToLine,
  playLine,
  timingLooksUncertain,
  withTimingChecks,
} from '../../../src/app/state/lyricChecks.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'

/** A line whose words have these confidences and start at these times (one per second by default). */
const line = (confidences: number[], starts = confidences.map((_, i) => i)): LyricLine => ({
  id: `l${confidences.join('-')}`,
  text: confidences.map((_, i) => `w${i}`).join(' '),
  start: starts[0],
  end: (starts.at(-1) ?? 0) + 0.5,
  words: confidences.map((confidence, i) => ({
    text: `w${i}`,
    start: starts[i] as number,
    end: (starts[i] as number) + 0.5,
    confidence,
  })),
})
const doc = (...confidences: number[]): LyricsDoc => ({ source: 'transcribed', lines: [line(confidences)] })

describe('lyric checks', () => {
  it('calls words uncertain below the measured mark, unplaced ones included', () => {
    expect(isUncertain({ text: 'x', start: 0, end: 1, confidence: 0 })).toBe(true)
    expect(isUncertain({ text: 'x', start: 0, end: 1, confidence: 0.09 })).toBe(true)
    expect(isUncertain({ text: 'x', start: 0, end: 1, confidence: 0.1 })).toBe(false)
    expect(isUncertain({ text: 'x', start: 0, end: 1 })).toBe(false)
  })

  it('says a draft looks unreliable when the median word confidence is below the mark', () => {
    expect(draftLooksUnreliable(doc(0, 0.02, 0.05, 0.6, 0.9))).toBe(true)
    expect(draftLooksUnreliable(doc(0, 0.02, 0.3, 0.6, 0.9))).toBe(false)
    // An even count takes the mean of the middle two: (0.08 + 0.14) / 2 = 0.11.
    expect(draftLooksUnreliable(doc(0, 0.08, 0.14, 0.9))).toBe(false)
    expect(draftLooksUnreliable(doc(0, 0.05, 0.12, 0.9))).toBe(true)
    expect(draftLooksUnreliable(doc())).toBe(false)
    expect(draftLooksUnreliable(undefined)).toBe(false)
  })

  it('flags a timed line by its mean word confidence or a long gap between word starts, not by one unplaced word', () => {
    expect(timingLooksUncertain(line([0.05, 0.1, 0.12]))).toBe(true)
    expect(timingLooksUncertain(line([0, 0.5, 0.6]))).toBe(false)
    expect(timingLooksUncertain(line([0.5, 0.6, 0.7], [0, 1, 3.5]))).toBe(true)
    expect(timingLooksUncertain(line([0.5, 0.6, 0.7], [0, 1, 2.9]))).toBe(false)
  })

  it('stores a draft with every line to check and its language, and timing with only its uncertain lines', () => {
    const draft = asDraft(doc(0.5, 0.6), 'sv')
    expect(draft.lines.map((l) => l.check)).toEqual(['words'])
    expect(draft.language).toBe('sv')
    expect(asDraft(doc(0.5), undefined)).not.toHaveProperty('language')
    const timed = withTimingChecks({ source: 'pasted', lines: [line([0.6, 0.7]), line([0.02, 0.05])] })
    expect(timed.lines.map((l) => l.check)).toEqual([undefined, 'timing'])
  })

  it('flags the lines within 10 s of unlisted singing of 4 s or more for it, rather than for their timing', () => {
    const lines = [
      line([0.02, 0.6], [9, 9.4]),
      line([0.6, 0.7], [9.6, 10]),
      line([0.02, 0.05], [25, 25.5]),
      line([0.6], [40]),
      line([0.6], [40.2]),
      line([0.02, 0.05], [50, 50.5]),
    ]
    const checks = (unlisted: { start: number; end: number }[]) =>
      withTimingChecks({ source: 'pasted', lines }, unlisted).lines.map((l) => l.check)
    expect(checks([{ start: 20, end: 30 }])).toEqual([
      undefined,
      'unlisted',
      'unlisted',
      'unlisted',
      undefined,
      'timing',
    ])
    expect(checks([{ start: 20, end: 24 }])).toEqual([
      undefined,
      'unlisted',
      'unlisted',
      undefined,
      undefined,
      'timing',
    ])
    // A shorter stretch, or none (the lyrics list every sung part), leaves the timing check alone.
    const timingOnly = [undefined, undefined, 'timing', undefined, undefined, 'timing']
    expect(checks([{ start: 20, end: 23.9 }])).toEqual(timingOnly)
    expect(checks([])).toEqual(timingOnly)
  })

  it('keeps unlisted singing rounded to 0.01 s, merged and in order, and only stretches of 4 s or more', () => {
    expect(
      longUnlisted([
        { start: 30.004, end: 34.004 },
        { start: 10, end: 13.996 },
        { start: 1, end: 3 },
        { start: 3, end: 6.5 },
        { start: 4, end: 5 },
        { start: 50, end: 53.99 },
      ]),
    ).toEqual([
      { start: 1, end: 6.5 },
      { start: 10, end: 14 },
      { start: 30, end: 34 },
    ])
  })

  it('names Whisper’s language codes, Javanese included', () => {
    expect(languageName('sv')).toBe('Swedish')
    expect(languageName('jw')).toBe('Javanese')
  })
})

/** Lines a (10–10.5 s, to check), b (10.6–11.5 s), c (10.6–11.5 s, to check), d (untimed, to check) and e (20 s). */
function checking(): Project {
  const project = createProject()
  const at = (
    id: string,
    start: number | undefined,
    end: number | undefined,
    check?: 'timing',
  ): LyricLine => ({
    id,
    text: id,
    start,
    end,
    words: [],
    ...(check ? { check } : {}),
  })
  project.lyrics = {
    source: 'pasted',
    lines: [
      at('a', 10, 10.5, 'timing'),
      at('b', 10.6, 11.5),
      at('c', 10.6, 11.5, 'timing'),
      at('d', undefined, undefined, 'timing'),
      at('e', 20, 21),
    ],
  }
  return project
}

describe('stepping through and playing the lines to check', () => {
  afterEach(() => set({ playing: false }))

  it('finds the next line to check after a line, from the first again after the last', () => {
    const project = checking()
    expect(nextToCheck(project)?.id).toBe('a')
    expect(nextToCheck(project, 'a')?.id).toBe('c')
    expect(nextToCheck(project, 'b')?.id).toBe('c')
    expect(nextToCheck(project, 'c')?.id).toBe('d')
    expect(nextToCheck(project, 'd')?.id).toBe('a')
    expect(nextToCheck(project, 'e')?.id).toBe('a')
    expect(nextToCheck(project, 'gone')?.id).toBe('a')
    project.lyrics!.lines = project.lyrics!.lines.map(({ check: _, ...l }) => l)
    expect(nextToCheck(project, 'a')).toBeUndefined()
  })

  it('moves the playhead to a line’s start unless it is in the line already', () => {
    editor.load(checking())
    set({ playhead: 3 })
    playheadToLine('c')
    expect(get().playhead).toBe(10.6)
    set({ playhead: 11 })
    playheadToLine('c')
    expect(get().playhead).toBe(11)
    playheadToLine('d')
    expect(get().playhead).toBe(11)
  })

  it('plays a line from its start and pauses once the playhead is past its end and the tail', () => {
    editor.load(checking())
    set({ playhead: 3 })
    playLine('c')
    expect(get()).toMatchObject({ playhead: 10.6, playing: true })
    for (const t of [11, 11.5, 11.9]) {
      set({ playhead: t })
      expect(get().playing).toBe(true)
    }
    set({ playhead: 11.5 + PLAY_LINE_TAIL })
    expect(get().playing).toBe(false)
    playLine('d')
    expect(get().playing).toBe(false)
  })

  it('pauses at the line’s end after a frame from where the playhead was before', () => {
    editor.load(checking())
    set({ playhead: 3 })
    playLine('c')
    for (const t of [3, 10.6, 11, 11.4, 11.8]) set({ playhead: t })
    expect(get().playing).toBe(true)
    set({ playhead: 12.1 })
    expect(get().playing).toBe(false)
  })

  it('leaves playback alone after a pause, a seek past the end or a while playing elsewhere, and when another line is played', () => {
    editor.load(checking())
    playLine('a')
    set({ playing: false })
    set({ playing: true, playhead: 10.7 })
    set({ playhead: 11.1 })
    expect(get().playing).toBe(true)

    playLine('a')
    set({ playhead: 15 })
    set({ playhead: 15.2 })
    expect(get().playing).toBe(true)

    // Line a lasts 1 s with its tail: after 3 s of playing from elsewhere, its end goes by.
    playLine('a')
    for (let t = 5; t <= 11.2; t += 0.2) set({ playhead: t })
    expect(get().playing).toBe(true)

    // Line a would pause at 11 s; playing c from 10.6 s goes on to 12 s.
    playLine('a')
    playLine('c')
    for (const t of [11, 11.4, 11.8]) set({ playhead: t })
    expect(get().playing).toBe(true)
    set({ playhead: 12 })
    expect(get().playing).toBe(false)
  })
})
