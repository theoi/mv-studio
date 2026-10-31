import { expect, it } from 'vitest'
import { editedAgo, formatParam } from '../../../src/app/format.ts'

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

it('shows a setting’s value with its unit, as a percentage for amounts and as a multiplier for factors', () => {
  const number = (o: { min: number; max: number; step?: number; unit?: string }) =>
    ({ key: 'k', label: 'K', type: 'number', default: o.min, ...o }) as const
  expect(formatParam(number({ min: 0.05, max: 1, step: 0.01 }), 0.6)).toBe('60%')
  expect(formatParam(number({ min: -1, max: 1, step: 0.01 }), -0.2)).toBe('-20%')
  expect(formatParam(number({ min: 0, max: 2, step: 0.01 }), 1)).toBe('1.0×')
  expect(formatParam(number({ min: -0.5, max: 0.5, step: 0.005, unit: 'turns/s' }), 0.02)).toBe(
    '0.02 turns/s',
  )
  expect(formatParam(number({ min: 0, max: 360, step: 1, unit: '°' }), 30)).toBe('30°')
  expect(formatParam(number({ min: 1, max: 6, step: 0.1 }), 2.5)).toBe('2.5')
})
