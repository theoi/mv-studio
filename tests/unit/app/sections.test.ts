import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createProject, type SongSection } from '../../../src/model/index.ts'
import {
  editor,
  sectionColor,
  sectionGuess,
  sectionKind,
  sectionName,
  sectionsOf,
  sectionTint,
} from '../../../src/app/state/project.ts'
import {
  MIN_SECTION,
  moveBoundary,
  moveBoundaryCommands,
  sectionBoundaries,
  sectionEdge,
} from '../../../src/app/state/sections.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

const section = (label: string, repeatGroup?: number): SongSection => ({
  id: label,
  label,
  start: 0,
  end: 8,
  energy: 0.5,
  ...(repeatGroup !== undefined ? { repeatGroup } : {}),
})

it.each([
  ['Verse 2', 1, 'verse'],
  ['Chorus', 2, 'chorus'],
  ['Hook', undefined, 'chorus'],
  ['Pre-chorus', 3, 'pre'],
  ['Bridge', undefined, 'bridge'],
  ['Intro', undefined, 'intro'],
  ['Outro', undefined, 'outro'],
] as const)('a section labeled %s (repeat group %s) is colored as %s', (label, group, kind) => {
  expect(sectionKind(section(label, group))).toBe(kind)
})

it.each([
  ['chorus', 0.4, 'Chorus', 'Probably the chorus'],
  ['verse', 0.4, 'Verse', 'Probably a verse'],
  ['verse 2', 0.4, 'Verse 2', 'Probably a verse'],
  ['bridge', 0.4, 'Bridge', 'Probably the bridge'],
  ['pre-chorus', 0.3, 'Pre-chorus', 'Probably the pre-chorus'],
  ['outro', 0.4, 'Outro', 'Probably the outro'],
  ['chorus', 0.8, 'Chorus', undefined],
  ['Chorus', undefined, 'Chorus', undefined],
  ['drop', 1, 'drop', undefined],
] as const)(
  'a section labeled %s with confidence %s is shown as %s, guessed: %s',
  (label, confidence, shown, guess) => {
    const s = { ...section(label), ...(confidence !== undefined ? { confidence } : {}) }
    expect(sectionName(s)).toBe(shown)
    expect(sectionGuess(s)).toBe(guess)
  },
)

describe('section colors', () => {
  it('uses the color the user picked, else the color of its kind', () => {
    expect(sectionTint({ ...section('Chorus'), color: 'bridge' })).toBe(sectionColor.bridge)
    expect(sectionTint({ ...section('Chorus'), color: 'not-a-color' })).toBe(sectionColor.chorus)
    expect(sectionTint(section('Chorus'))).toBe(sectionColor.chorus)
  })
})

describe('section edges', () => {
  const a = { ...section('Verse'), id: 'a', start: 0, end: 10 }
  const b = { ...section('Chorus'), id: 'b', start: 10, end: 20 }
  const c = { ...section('Outro'), id: 'c', start: 24, end: 30 }

  it('lists a boundary two sections share once, and stops each edge at its neighbors', () => {
    const edges = sectionBoundaries([c, a, b], 40).map((e) => ({
      t: e.t,
      before: e.before?.id,
      after: e.after?.id,
      min: e.min,
      max: e.max,
    }))
    expect(edges).toEqual([
      { t: 0, before: undefined, after: 'a', min: 0, max: 10 - MIN_SECTION },
      { t: 10, before: 'a', after: 'b', min: MIN_SECTION, max: 20 - MIN_SECTION },
      { t: 20, before: 'b', after: undefined, min: 10 + MIN_SECTION, max: 24 },
      { t: 24, before: undefined, after: 'c', min: 20, max: 30 - MIN_SECTION },
      { t: 30, before: 'c', after: undefined, min: 24 + MIN_SECTION, max: 40 },
    ])
  })

  it('moves a shared boundary in both sections, kept within its range', () => {
    const shared = sectionBoundaries([a, b, c], 40)[1]!
    expect(moveBoundaryCommands('song', shared, 25)).toEqual([
      { type: 'analysis.updateSection', assetId: 'song', sectionId: 'a', patch: { end: 19 } },
      { type: 'analysis.updateSection', assetId: 'song', sectionId: 'b', patch: { start: 19 } },
    ])
  })

  it('drags as one undo step', () => {
    const p = createProject({ name: 'sections' })
    p.songAssetId = 'song'
    p.analysis.audio.song = { assetId: 'song', version: 'v1', sections: [a, b, c] }
    editor.load(p)
    const edge = sectionEdge(editor.getProject(), 'b', 'start')!
    for (const t of [11, 12, 12.5]) moveBoundary(edge, t, 'drag')
    editor.endGesture()
    const spans = () => sectionsOf(editor.getProject()).map((s) => [s.start, s.end])
    expect(spans()).toEqual([
      [0, 12.5],
      [12.5, 20],
      [24, 30],
    ])
    editor.undo()
    expect(spans()).toEqual([
      [0, 10],
      [10, 20],
      [24, 30],
    ])
  })
})
