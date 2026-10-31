import { describe, expect, it } from 'vitest'
import { findLyricChorus, lyricChorusCommand, withChorus } from '../../../src/analysis/structure/chorus.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import {
  createProject,
  type AudioAnalysis,
  type LyricLine,
  type SongSection,
} from '../../../src/model/index.ts'

/** Lines sung one after another, each `seconds` long, starting at `start`. */
function sing(texts: string[], start: number, seconds = 3): LyricLine[] {
  return texts.map((text, i) => ({
    id: `${start}-${i}`,
    text,
    start: start + i * seconds,
    end: start + (i + 1) * seconds - 0.5,
    words: [],
  }))
}

const CHORUS = ['We sing all night long', 'Under the neon light', 'Nobody can stop us now']

describe('findLyricChorus', () => {
  it('finds every occurrence of the repeated run of lines, tolerating small word changes', () => {
    const lines = [
      ...sing(
        ['Woke up late on a Sunday', 'Coffee cold and the radio on', 'Called you twice', 'Yeah yeah'],
        10,
      ),
      ...sing(CHORUS, 25),
      ...sing(['Streets are empty', 'Yeah yeah', 'Shoes in my hand and the rain', 'Taxi lights'], 40),
      ...sing(['Oh we sing all night long', 'Under the neon light', 'Nobody can stop us now'], 55),
      ...sing(['Bridge line one', 'Bridge line two'], 70),
      ...sing(CHORUS, 80),
    ]
    expect(findLyricChorus(lines)).toEqual([
      { start: 25, end: 33.5 },
      { start: 55, end: 63.5 },
      { start: 80, end: 88.5 },
    ])
  })

  it('needs a run of at least two lines and keeps a late last line from stretching an occurrence', () => {
    expect(findLyricChorus([...sing(['Yeah yeah', 'One'], 0), ...sing(['Yeah yeah', 'Two'], 10)])).toBeNull()
    const held = sing(CHORUS, 60)
    held[2] = { ...held[2]!, end: 90 }
    const ranges = findLyricChorus([
      ...sing(CHORUS, 0),
      ...sing(['A verse'], 20),
      ...sing(CHORUS, 30),
      ...held,
    ])
    expect(ranges?.map((r) => r.end - r.start)).toEqual([8.5, 8.5, 8.5 * 1.25])
  })
})

const section = (
  id: string,
  start: number,
  end: number,
  label: string,
  repeatGroup?: number,
): SongSection => ({
  id,
  start,
  end,
  label,
  repeatGroup,
  energy: 0.5,
})

describe('withChorus', () => {
  it('cuts sections at the chorus edges on downbeats, relabels inside and outside, and keeps user labels', () => {
    const sections = [
      section('a', 0, 10, 'intro'),
      section('b', 10, 40, 'verse', 0),
      section('c', 40, 60, 'chorus', 1),
      section('d', 60, 80, 'Hook', 1),
    ]
    const downbeats = [0, 5, 10, 15, 20, 24.6, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75]
    const next = withChorus(
      sections,
      [
        { start: 25.3, end: 39.4 },
        { start: 65.2, end: 75 },
      ],
      downbeats,
    )
    expect(next.map((s) => [s.id, s.start, s.end, s.label, s.repeatGroup])).toEqual([
      ['a', 0, 10, 'intro', undefined],
      ['b', 10, 24.6, 'verse', 0],
      ['b.1', 24.6, 40, 'chorus', 2],
      ['c', 40, 60, 'verse', 1],
      ['d', 60, 80, 'Hook', 1],
    ])
  })
})

describe('lyricChorusCommand', () => {
  const analysis: AudioAnalysis = {
    assetId: 'song',
    version: '1',
    downbeats: [0, 25, 34, 55, 64, 80, 89],
    sections: [
      section('a', 0, 55, 'verse', 0),
      section('b', 55, 70, 'chorus', 1),
      section('c', 70, 95, 'verse', 2),
    ],
  }
  const lyrics = {
    source: 'pasted' as const,
    lines: [
      ...sing(['Verse words here', 'More verse words'], 10),
      ...sing(CHORUS, 25),
      ...sing(CHORUS, 55),
      ...sing(CHORUS, 80),
    ],
  }

  it('relabels the sections without an undo step, unless they changed since', () => {
    const editor = new ProjectEditor(createProject())
    editor.dispatch({ type: 'analysis.setDetected', analysis }, { history: 'skip' })
    const command = lyricChorusCommand(analysis, lyrics)
    expect(command).not.toBeNull()
    editor.dispatch(command!, { history: 'skip' })
    const labels = (editor.getProject().analysis.audio.song?.sections ?? []).map((s) => [s.start, s.label])
    expect(labels).toEqual([
      [0, 'verse'],
      [25, 'chorus'],
      [34, 'verse'],
      [55, 'chorus'],
      [64, 'verse'],
      [80, 'chorus'],
      [89, 'verse'],
    ])
    expect(editor.canUndo()).toBe(false)

    editor.load(createProject())
    editor.dispatch({ type: 'analysis.setDetected', analysis }, { history: 'skip' })
    editor.dispatch({ type: 'analysis.updateSection', assetId: 'song', sectionId: 'b', patch: { end: 66 } })
    editor.dispatch(command!, { history: 'skip' })
    expect(editor.getProject().analysis.audio.song?.sections?.[1]).toMatchObject({
      id: 'b',
      label: 'chorus',
      end: 66,
    })
  })

  it('returns null without a repeated run of lines', () => {
    expect(
      lyricChorusCommand(analysis, { source: 'pasted', lines: sing(['One', 'Two', 'Three'], 0) }),
    ).toBeNull()
  })
})
