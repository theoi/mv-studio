import { expect, it } from 'vitest'
import type { SongSection } from '../../../src/model/index.ts'
import { sectionKind } from '../../../src/app/state/project.ts'

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
