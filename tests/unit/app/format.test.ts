import { expect, it } from 'vitest'
import { editedAgo } from '../../../src/app/format.ts'

const now = new Date(2026, 9, 31, 15, 0).getTime()
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString()

it('says how long ago a project was edited, in minutes and hours on the same day', () => {
  expect(editedAgo(new Date(now - 20_000).toISOString(), now)).toBe('Edited just now')
  expect(editedAgo(new Date(now - 60_000).toISOString(), now)).toBe('Edited 1 minute ago')
  expect(editedAgo(new Date(now - 59 * 60_000).toISOString(), now)).toBe('Edited 59 minutes ago')
  expect(editedAgo(at(2026, 9, 31, 1, 30), now)).toBe('Edited 13 hours ago')
})

it('says "yesterday", then the date, with the year only when it is not this year', () => {
  // Shortly after midnight, an edit from late last night still reads in hours.
  expect(editedAgo(at(2026, 9, 30, 22, 0), new Date(2026, 9, 31, 2, 0).getTime())).toBe('Edited 4 hours ago')
  expect(editedAgo(at(2026, 9, 30, 2, 0), now)).toBe('Edited yesterday')
  expect(editedAgo(at(2026, 9, 24, 12, 0), now)).toBe('Edited Oct 24')
  expect(editedAgo(at(2025, 11, 2, 12, 0), now)).toBe('Edited Dec 2, 2025')
})
