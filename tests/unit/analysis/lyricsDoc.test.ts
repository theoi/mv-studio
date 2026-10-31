import { describe, expect, it } from 'vitest'
import { groupWordsIntoLines, toLyricsDoc } from '../../../src/analysis/lyrics/doc.ts'
import type { LyricWord } from '../../../src/model/types.ts'

/** Words of `text` spoken back to back, `step` seconds apart, starting at `start`. */
function speak(text: string, start: number, step = 0.3): LyricWord[] {
  return text
    .split(' ')
    .map((t, i) => ({ text: t, start: start + i * step, end: start + i * step + step * 0.9 }))
}

const texts = (lines: LyricWord[][]) => lines.map((l) => l.map((w) => w.text).join(' '))

describe('groupWordsIntoLines', () => {
  it('starts a new line after a pause', () => {
    const words = [...speak('we were young', 1), ...speak('and the night was long', 3)]
    expect(texts(groupWordsIntoLines(words))).toEqual(['we were young', 'and the night was long'])
    expect(texts(groupWordsIntoLines(words, { maxGap: 2 }))).toEqual(['we were young and the night was long'])
  })

  it('starts a new line at each boundary between words, ignoring boundaries before the first word', () => {
    const words = speak('hold on to me now hold on to me', 2)
    const lines = groupWordsIntoLines(words, { boundaries: [0.5, 2 + 4 * 0.3] })
    expect(texts(lines)).toEqual(['hold on to me', 'now hold on to me'])
  })

  it('tolerates a boundary slightly after the start of the first word of the new line', () => {
    const words = speak('one two three four', 0)
    expect(texts(groupWordsIntoLines(words, { boundaries: [0.62] }))).toEqual(['one two', 'three four'])
  })

  it('ends a line at sentence-ending punctuation', () => {
    const words = speak('Run away! Run away, my dear.', 0)
    expect(texts(groupWordsIntoLines(words))).toEqual(['Run away!', 'Run away, my dear.'])
  })

  it('splits long lines at the largest pause or comma, keeping every word once', () => {
    const words = [
      ...speak('a b c d e f', 0, 0.25),
      ...speak('g h i j k l', 1.8, 0.25),
      ...speak('m n o', 3.5, 0.25),
    ]
    const lines = groupWordsIntoLines(words, { maxWords: 8, maxGap: 1 })
    expect(texts(lines)).toEqual(['a b c d e f', 'g h i j k l', 'm n o'])
    const commas = speak('la la la, la la la la, la la la la', 0, 0.25)
    const split = groupWordsIntoLines(commas, { maxWords: 6 })
    expect(texts(split)).toEqual(['la la la,', 'la la la la,', 'la la la la'])
  })

  it('splits lines longer than maxDuration', () => {
    const words = speak('slow words sung over many many seconds', 0, 1)
    const lines = groupWordsIntoLines(words, { maxDuration: 4, maxGap: 5 })
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines)
      expect((line.at(-1) as LyricWord).end - (line[0] as LyricWord).start).toBeLessThanOrEqual(4)
    expect(lines.flat().map((w) => w.text)).toEqual(words.map((w) => w.text))
  })

  it('trims words, drops empty ones and orders by start time', () => {
    const words: LyricWord[] = [
      { text: ' world', start: 0.5, end: 0.9 },
      { text: '  ', start: 0.3, end: 0.4 },
      { text: 'Hello ', start: 0, end: 0.4 },
    ]
    expect(texts(groupWordsIntoLines(words))).toEqual(['Hello world'])
  })
})

describe('toLyricsDoc', () => {
  it('builds transcribed lines spanning their words, keeping word confidence', () => {
    const words = [...speak('first line here', 0), { text: 'again', start: 5, end: 5.4, confidence: 0.42 }]
    const doc = toLyricsDoc(words, { audioAssetId: 'song-1' })
    expect(doc.source).toBe('transcribed')
    expect(doc.audioAssetId).toBe('song-1')
    expect(doc.lines.map((l) => [l.text, l.start, l.end])).toEqual([
      ['first line here', 0, 0.6 + 0.27],
      ['again', 5, 5.4],
    ])
    expect(doc.lines[1]?.words[0]?.confidence).toBe(0.42)
    expect(new Set(doc.lines.map((l) => l.id)).size).toBe(2)
    expect(toLyricsDoc(words, { source: 'mixed' }).source).toBe('mixed')
  })
})
