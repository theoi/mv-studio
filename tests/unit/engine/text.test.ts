import { describe, expect, it } from 'vitest'
import { karaokeFill, layoutText, lyricWordTimings, pacedTimings } from '../../../src/engine/text.ts'
import {
  DEFAULT_TEXT_STYLE,
  createAudioClip,
  createProject,
  createTextClip,
  newId,
} from '../../../src/model/factory.ts'
import type { Project, TextStyle, Track } from '../../../src/model/types.ts'

const measure = (text: string) => text.length * 10

function layout(text: string, style: Partial<TextStyle> = {}) {
  return layoutText({
    text,
    style: { ...DEFAULT_TEXT_STYLE, fontSize: 100, lineHeight: 1, ...style },
    // A 1080-pixel-tall canvas keeps font sizes unscaled.
    canvasWidth: 1000,
    canvasHeight: 1080,
    font: 'test',
    padding: 5,
    measure,
  })
}

describe('layoutText', () => {
  it('wraps words greedily at the max width and centers lines in the block', () => {
    // maxWidth 0.1 of 1000 px = 100 px; "aa bbb" is 60 px and adding " cccc" would make 110.
    const l = layout('aa bbb cccc dd', { maxWidth: 0.1 })
    expect(l.lines.map((line) => line.text)).toEqual(['aa bbb', 'cccc dd'])
    expect(l.width).toBe(70 + 10)
    expect(l.height).toBe(200 + 10)
    expect(l.lines.map((line) => line.x)).toEqual([5 + 5, 5])
    expect(l.words.map((w) => [w.text, w.x, w.y, w.line])).toEqual([
      ['aa', 10, 55, 0],
      ['bbb', 40, 55, 0],
      ['cccc', 5, 155, 1],
      ['dd', 55, 155, 1],
    ])
  })

  it('keeps explicit line breaks, aligns left or right and applies the text transform', () => {
    const left = layout('ab\nabcd', { align: 'left', textTransform: 'uppercase' })
    expect(left.lines.map((l) => [l.text, l.x])).toEqual([
      ['AB', 5],
      ['ABCD', 5],
    ])
    const right = layout('ab\nabcd', { align: 'right' })
    expect(right.lines.map((l) => l.x)).toEqual([25, 5])
  })

  it('scales the font with the canvas height', () => {
    const l = layoutText({
      text: 'a',
      style: { ...DEFAULT_TEXT_STYLE, fontSize: 100 },
      canvasWidth: 960,
      canvasHeight: 540,
      font: 'test',
      padding: 0,
      measure,
    })
    expect(l.fontPx).toBe(50)
  })
})

function lyricProject(text: string, lyricWords: [string, number, number][]) {
  const project: Project = createProject()
  const visual = project.tracks.find((t) => t.kind === 'visual') as Track
  const audio = project.tracks.find((t) => t.kind === 'audio') as Track
  const songId = newId()
  project.songAssetId = songId
  // The song starts at timeline 10 s, trimmed to begin 2 s into the file: asset time t plays at 8 + t.
  const song = createAudioClip({
    trackId: audio.id,
    assetId: songId,
    start: 10,
    duration: 60,
    sourceStart: 2,
  })
  project.clips[song.id] = song
  const lineId = newId()
  project.lyrics = {
    source: 'pasted',
    lines: [{ id: lineId, text: '', words: lyricWords.map(([w, start, end]) => ({ text: w, start, end })) }],
  }
  const clip = {
    ...createTextClip({ trackId: visual.id, text, start: 10, duration: 5 }),
    lyricLineId: lineId,
  }
  return { project, clip }
}

describe('lyricWordTimings', () => {
  it('maps lyric word times from song time to timeline time', () => {
    const { project, clip } = lyricProject('Hello world', [
      ['Hello', 3, 3.5],
      ['world', 3.5, 4],
    ])
    expect(lyricWordTimings(project, clip)).toEqual([
      { start: 11, end: 11.5 },
      { start: 11.5, end: 12 },
    ])
  })

  it('matches edited clip text to lyric words in order', () => {
    const { project, clip } = lyricProject('Oh, hello there WORLD!', [
      ['hello', 3, 3.5],
      ['world', 3.5, 4],
    ])
    expect(lyricWordTimings(project, clip)).toEqual([
      undefined,
      { start: 11, end: 11.5 },
      undefined,
      { start: 11.5, end: 12 },
    ])
  })
})

describe('karaoke', () => {
  const l = layout('aa bb\ncc', { maxWidth: 1 })
  const timings = pacedTimings(l.words, 0, 10)

  it('paces words by length over most of the clip when there are no lyric timings', () => {
    expect(timings.map((t) => [t.start, t.end])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ])
  })

  it('fills the current word progressively, or whole lines once they start', () => {
    const [a, b, c] = l.words
    expect(karaokeFill(a!, l, timings, 1.5, 'word')).toBeCloseTo(0.5)
    expect(karaokeFill(b!, l, timings, 1.5, 'word')).toBe(0)
    expect(karaokeFill(a!, l, timings, 4, 'word')).toBe(1)
    expect(karaokeFill(b!, l, timings, 0.1, 'line')).toBe(1)
    expect(karaokeFill(c!, l, timings, 5, 'line')).toBe(0)
  })
})
