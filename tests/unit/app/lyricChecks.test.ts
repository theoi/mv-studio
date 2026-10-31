import { describe, expect, it } from 'vitest'
import type { LyricLine, LyricsDoc } from '../../../src/model/index.ts'
import {
  asDraft,
  draftLooksUnreliable,
  isUncertain,
  languageName,
  timingLooksUncertain,
  withTimingChecks,
} from '../../../src/app/state/lyricChecks.ts'

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

  it('names Whisper’s language codes, Javanese included', () => {
    expect(languageName('sv')).toBe('Swedish')
    expect(languageName('jw')).toBe('Javanese')
  })
})
