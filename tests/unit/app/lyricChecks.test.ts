import { afterEach, describe, expect, it, vi } from 'vitest'
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
  showNextToCheck,
  timingLooksUncertain,
  withTimingChecks,
} from '../../../src/app/state/lyricChecks.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, select, set } from '../../../src/app/state/ui.ts'

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
  afterEach(() => {
    set({ playing: false })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

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

  /** The time `performance.now()` gives, in ms. */
  let clock = 0
  /** Frames of playback at 1×: each moves the clock on by as long as the playhead moves. */
  const play = (...times: number[]) => {
    for (const t of times) {
      clock += (t - get().playhead) * 1000
      set({ playhead: t })
    }
  }
  /** A frame one frame's time after the last, at `t`: a seek, or a frame from before one. */
  const jump = (t: number) => {
    clock += 16
    set({ playhead: t })
  }

  it('plays a line from its start and pauses once the playhead is past its end and the tail', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    set({ playhead: 3 })
    playLine('c')
    expect(get()).toMatchObject({ playhead: 10.6, playing: true })
    for (const t of [10.62, 11, 11.5, 11.9]) {
      play(t)
      expect(get().playing).toBe(true)
    }
    play(11.5 + PLAY_LINE_TAIL)
    expect(get().playing).toBe(false)
    playLine('d')
    expect(get().playing).toBe(false)
  })

  it('pauses at the end after a frame from before the seek to the line, also one from early in the line', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    set({ playhead: 3 })
    playLine('c')
    jump(3)
    jump(10.62)
    play(11, 11.4, 11.8)
    expect(get().playing).toBe(true)
    play(12.1)
    expect(get().playing).toBe(false)

    // Play line again 0.3 s into the line: the frame from before reads 10.9 s, then playback goes on from 10.62 s.
    set({ playhead: 10.9 })
    playLine('c')
    jump(10.9)
    jump(10.62)
    play(11.5, 11.9)
    expect(get().playing).toBe(true)
    play(12.05)
    expect(get().playing).toBe(false)
  })

  it('pauses at the end after a late frame (a stall, or a hidden tab while the audio plays on)', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    playLine('a')
    play(10.02, 10.4)
    expect(get().playing).toBe(true)
    play(11.6)
    expect(get().playing).toBe(false)
  })

  it('leaves playback alone once the playhead moves to the next line before the end', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    // Line a would pause at 11 s; b starts at 10.6 s.
    playLine('a')
    play(10.02, 10.3)
    jump(10.6)
    play(10.8, 11.2)
    expect(get().playing).toBe(true)

    // Even when the time that passed matches the jump.
    playLine('a')
    play(10.02, 10.45)
    clock += 150
    playheadToLine('b')
    expect(get().playhead).toBe(10.6)
    play(10.8, 11.2)
    expect(get().playing).toBe(true)

    // Or when Next line to check moves it to the next line to check (c, also at 10.6 s).
    vi.stubGlobal('requestAnimationFrame', () => 0)
    select({ type: 'lyric', id: 'a' })
    playLine('a')
    play(10.02, 10.45)
    clock += 150
    showNextToCheck()
    expect(get()).toMatchObject({ playhead: 10.6, selection: { type: 'lyric', id: 'c' } })
    play(10.8, 11.2)
    expect(get().playing).toBe(true)
  })

  it('leaves playback alone after a pause, a seek past the end, or a wait with no playback from the line', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    playLine('a')
    play(10.1)
    set({ playing: false })
    set({ playing: true })
    play(10.7, 11.1)
    expect(get().playing).toBe(true)

    playLine('a')
    play(10.1)
    jump(15)
    play(15.2)
    expect(get().playing).toBe(true)

    playLine('a')
    clock += 1500
    jump(30)
    jump(10.1)
    play(10.6, 11.2)
    expect(get().playing).toBe(true)
  })

  it('stops watching line a when line c is played', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    editor.load(checking())
    // Line a would pause at 11 s, and the jump to c's start passes as playback of a; c goes on to 12 s.
    playLine('a')
    play(10.02, 10.3)
    clock += 300
    playLine('c')
    play(10.62, 11, 11.4, 11.8)
    expect(get().playing).toBe(true)
    play(12)
    expect(get().playing).toBe(false)
  })
})
