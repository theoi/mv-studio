import { describe, expect, it } from 'vitest'
import {
  findLyricChorus,
  lyricChorusCommand,
  lyricChorusRanges,
  withChorus,
} from '../../../src/analysis/structure/chorus.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import {
  createProject,
  type AudioAnalysis,
  type LyricLine,
  type SongSection,
} from '../../../src/model/index.ts'

/** Lines sung one after another, each `seconds` long, starting at `start`; words spread evenly over each line. */
function sing(texts: string[], start: number, seconds = 3): LyricLine[] {
  return texts.map((text, i) => ({
    id: `${start}-${i}`,
    text,
    start: start + i * seconds,
    end: start + (i + 1) * seconds - 0.5,
    words: [],
  }))
}

/** Lines with word times: every word lasts `perWord` seconds, one after another from `start`. */
function say(texts: string[], start: number, perWord = 0.5): LyricLine[] {
  let t = start
  return texts.map((text, i) => {
    const words = text.split(' ').map((w) => ({ text: w, start: t, end: (t += perWord) }))
    return { id: `${start}-${i}`, text, start: words[0]!.start, end: words.at(-1)!.end, words }
  })
}

const CHORUS = ['We sing all night long', 'Under the neon light', 'Nobody can stop us now']
const ranges = (lines: LyricLine[]) => findLyricChorus(lines)?.ranges ?? null

describe('findLyricChorus', () => {
  it('finds every occurrence of the repeated passage, tolerating changed and added words', () => {
    const lines = [
      ...sing(
        ['Woke up late on a Sunday', 'Coffee cold and the radio on', 'Called you twice', 'Yeah yeah'],
        10,
      ),
      ...sing(CHORUS, 25),
      ...sing(['Streets are empty', 'Yeah yeah', 'Shoes in my hand and the rain', 'Taxi lights'], 40),
      ...sing(['We sing all night long', 'Under the neon light', 'Nobody could stop us now'], 55),
      ...sing(['Bridge line one', 'Bridge line two'], 70),
      ...sing(['Oh we sing all night long', 'Under the neon light', 'Nobody can stop us now'], 80),
    ]
    const found = ranges(lines)
    expect(found?.map((r) => r.start)).toEqual([25, 55, 80 + 2.5 / 6])
    expect(found?.map((r) => r.end)).toEqual([33.5, 63.5, 88.5])
  })

  it('matches word by word, so the same chorus broken into other lines is still found', () => {
    const lines = [
      ...say(['We sing all night long under', 'the neon light nobody can stop us now'], 20),
      ...say(['Something else entirely', 'that is only sung here once'], 40),
      ...say(['We sing all night long', 'under the neon light', 'nobody can stop us now'], 60),
    ]
    expect(ranges(lines)).toEqual([
      { start: 20, end: 27 },
      { start: 60, end: 67 },
    ])
  })

  it('leaves out words before a pause that only match because the lines before end alike', () => {
    const lines = [
      ...sing(['The first verse ends with fire'], 0),
      ...sing(CHORUS, 10),
      ...sing(['A second verse ends with fire'], 30),
      ...sing(CHORUS, 40),
    ]
    expect(ranges(lines)).toEqual([
      { start: 10, end: 18.5 },
      { start: 40, end: 48.5 },
    ])
  })

  it('needs at least six words sung again and keeps a late last line from stretching an occurrence', () => {
    expect(
      ranges([...sing(['Yeah yeah', 'One more time'], 0), ...sing(['Yeah yeah', 'One more time'], 10)]),
    ).toBeNull()
    const held = sing(CHORUS, 60)
    held[2] = { ...held[2]!, end: 90 }
    const found = ranges([...sing(CHORUS, 0), ...sing(['A verse'], 20), ...sing(CHORUS, 30), ...held])
    expect(found?.map((r) => r.end - r.start)).toEqual([8.5, 8.5, 8.5 * 1.25])
  })
})

const section = (
  id: string,
  start: number,
  end: number,
  label: string,
  repeatGroup?: number,
  confidence?: number,
): SongSection => ({ id, start, end, label, repeatGroup, energy: 0.5, ...(confidence ? { confidence } : {}) })

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
      0.4,
    )
    expect(next.map((s) => [s.id, s.start, s.end, s.label, s.repeatGroup])).toEqual([
      ['a', 0, 10, 'intro', undefined],
      ['b', 10, 24.6, 'verse', 0],
      ['b.1', 24.6, 40, 'chorus', 2],
      ['c', 40, 60, 'verse', 1],
      ['d', 60, 80, 'Hook', 1],
    ])
  })

  it('gives each range its confidence, or the default, and keeps labels the user confirmed', () => {
    const sections = [
      section('a', 0, 20, 'verse', 0, 1),
      section('b', 20, 40, 'verse', 0),
      section('c', 40, 60, 'chorus', 1, 1),
      section('d', 60, 80, 'chorus', 1, 0.4),
      section('e', 80, 100, 'verse', 2),
    ]
    const next = withChorus(
      sections,
      [
        { start: 10, end: 30 },
        { start: 80, end: 100, confidence: 0.4 },
      ],
      [],
      0.8,
    )
    expect(next.map((s) => [s.start, s.end, s.label, s.confidence])).toEqual([
      [0, 20, 'verse', 1],
      [20, 30, 'chorus', 0.8],
      [30, 40, 'verse', undefined],
      [40, 60, 'chorus', 1],
      [60, 80, 'verse', undefined],
      [80, 100, 'chorus', 0.4],
    ])
  })
})

const VERSE_1 = ['Woke up late on a Sunday morning', 'coffee cold and the radio on']
const VERSE_2 = ['Streets are empty and the shops are closed', 'shoes in my hand']
const VERSE_3 = ['Every window shows a different face', 'nobody knows my name']
const VERSE_4 = ['Out in the cold where the rivers bend', 'we walk alone']

describe('lyricChorusRanges', () => {
  const chorusAt = (sections: SongSection[], lines: LyricLine[]) =>
    lyricChorusRanges(sections, findLyricChorus(lines)!).map((r) => [r.start, r.end, r.confidence])

  it('confirms a detected chorus without shrinking it, demotes one where a verse is sung, and runs a lyric chorus on to the edge of its section', () => {
    const sections = [
      section('a', 0, 10, 'intro'),
      section('b', 10, 30, 'verse', 0),
      section('c', 30, 50, 'chorus', 1, 0.4),
      section('d', 50, 70, 'verse', 0),
      section('e', 70, 90, 'chorus', 1, 0.4),
      section('f', 90, 110, 'verse', 2),
    ]
    const lines = [
      ...say(VERSE_1, 12),
      ...say(CHORUS, 31),
      ...say(VERSE_2, 52),
      ...say(VERSE_3, 72),
      ...say(CHORUS, 92),
      ...say(VERSE_4, 101),
    ]
    // Chorus 2 (92-99) covers too little of f to take it over: it starts with f, and ends where the verse begins.
    expect(chorusAt(sections, lines)).toEqual([
      [30, 50, 0.8],
      [90, 99, 0.8],
    ])
  })

  it('keeps a detected chorus where repeated words are sung and extends one by at most a quarter', () => {
    const PRE = ['Here it comes again tonight', 'can you feel it rising']
    const sections = [
      section('a', 0, 20, 'verse', 0),
      section('b', 20, 40, 'chorus', 1, 0.4),
      section('c', 40, 60, 'verse', 0),
      section('d', 60, 80, 'chorus', 1, 0.4),
      section('e', 80, 100, 'bridge', 2),
      section('f', 100, 120, 'chorus', 1, 0.4),
    ]
    const lines = [
      ...say(VERSE_1, 2),
      ...say([...PRE, ...CHORUS], 14),
      ...say(VERSE_2, 42),
      ...say([...PRE, ...CHORUS], 54),
      ...say(VERSE_3, 82),
      ...say([...PRE, ...PRE], 102),
    ]
    // The lyrics' chorus starts with the pre-chorus at 14 and 54.
    expect(chorusAt(sections, lines)).toEqual([
      [15, 40, 0.8],
      [55, 80, 0.8],
      [100, 120, 0.4],
    ])
  })

  it('lets a lyric chorus take over a section it covers most of, or run on to its edge where nothing is sung', () => {
    const sections = [
      section('a', 0, 20, 'verse', 0),
      section('b', 20, 30, 'verse', 0),
      section('c', 30, 40, 'bridge'),
    ]
    const lines = [...say(CHORUS, 2), ...say(VERSE_2, 12, 0.3), ...say(CHORUS, 22)]
    expect(chorusAt(sections, lines)).toEqual([
      [0, 9, 0.8],
      [20, 30, 0.8],
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
      ...sing(['Second verse begins', 'something else entirely'], 40),
      ...sing(CHORUS, 55),
      ...sing(['Third verse is here', 'nothing like the others'], 72),
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
      [70, 'verse'],
      [80, 'chorus'],
    ])
    const choruses = editor.getProject().analysis.audio.song?.sections?.filter((s) => s.label === 'chorus')
    expect(choruses?.map((s) => s.confidence)).toEqual([0.8, 0.8, 0.8])
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

  it('puts the chorus edges on beats while bars are not found', () => {
    const beats = Array.from({ length: 200 }, (_, i) => i * 0.5)
    const lines = [
      ...sing(['Verse words here', 'More verse words'], 10),
      ...sing(CHORUS, 25.2),
      ...sing(['Second verse begins', 'something else entirely'], 40),
      ...sing(CHORUS, 55.2),
    ]
    const command = lyricChorusCommand(
      { ...analysis, downbeats: undefined, beats },
      { source: 'pasted', lines },
    )
    const sections = command?.type === 'analysis.setRefined' ? command.refined.sections : undefined
    expect(sections?.filter((s) => s.label === 'chorus').map((s) => [s.start, s.end])).toEqual([
      [25, 33.5],
      [55, 70],
    ])
  })

  it('returns null without a repeated passage', () => {
    expect(
      lyricChorusCommand(analysis, { source: 'pasted', lines: sing(['One', 'Two', 'Three'], 0) }),
    ).toBeNull()
  })

  it('lets drafted lyrics confirm the detected chorus without moving it, and only where they repeat inside it', () => {
    const detected: AudioAnalysis = {
      ...analysis,
      sections: [
        section('a', 0, 25, 'verse', 0),
        section('b', 25, 34, 'chorus', 1, 0.4),
        section('c', 34, 55, 'verse', 0),
        section('d', 55, 64, 'chorus', 1, 0.4),
        section('e', 64, 80, 'bridge', 2),
        section('f', 80, 95, 'Hook', 1, 1),
      ],
    }
    const command = lyricChorusCommand(detected, { ...lyrics, source: 'transcribed' })
    expect(command?.type === 'analysis.setRefined' && command.refined.sections).toEqual(
      detected.sections?.map((s) => (s.label === 'chorus' ? { ...s, confidence: 0.6 } : s)),
    )
    expect(lyricChorusCommand(analysis, { ...lyrics, source: 'mixed' })).toBeNull()
  })
})
