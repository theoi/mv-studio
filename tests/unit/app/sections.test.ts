import { expect, it } from 'vitest'
import type { SongSection } from '../../../src/model/index.ts'
import { sectionGuess, sectionKind, sectionName } from '../../../src/app/state/project.ts'

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
