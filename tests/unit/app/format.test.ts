import { expect, it } from 'vitest'
import { exportFileName } from '../../../src/engine/export.ts'
import {
  aboutMinutes,
  distinctName,
  editedAgo,
  editedTimes,
  formatParam,
  formatTime,
  formatTimecode,
  noMatch,
  shortFileName,
  undoAction,
} from '../../../src/app/format.ts'

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

it('tells two versions apart by clock time when "Edited …" reads the same for both', () => {
  const later = new Date(2026, 9, 31, 15, 0, 30).getTime()
  const iso = (...parts: number[]) =>
    new Date(...(parts as [number, number, number, number, number, number])).toISOString()
  // Different wording stays as it is, and so does one version compared with itself.
  expect(editedTimes(iso(2026, 9, 31, 14, 50, 0), iso(2026, 9, 31, 15, 0, 0), later)).toEqual([
    'Edited 10 minutes ago',
    'Edited just now',
  ])
  expect(editedTimes(iso(2026, 9, 31, 15, 0, 10), iso(2026, 9, 31, 15, 0, 10), later)).toEqual([
    'Edited just now',
    'Edited just now',
  ])
  // Both "just now": the minutes, then the seconds when the minute matches.
  expect(editedTimes(iso(2026, 9, 31, 15, 0, 10), iso(2026, 9, 31, 14, 59, 50), later)).toEqual([
    'Edited 3:00 PM',
    'Edited 2:59 PM',
  ])
  expect(editedTimes(iso(2026, 9, 31, 15, 0, 20), iso(2026, 9, 31, 15, 0, 5), later)).toEqual([
    'Edited 3:00:20 PM',
    'Edited 3:00:05 PM',
  ])
  // Both "Edited Oct 24": the date with the time.
  expect(editedTimes(iso(2026, 9, 24, 9, 15, 0), iso(2026, 9, 24, 0, 40, 0), later)).toEqual([
    'Edited Oct 24, 9:15 AM',
    'Edited Oct 24, 12:40 AM',
  ])
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

it('rounds a wait up to the next minute, so "About 5 min" never stands for 5 min 26 s', () => {
  expect(aboutMinutes(45)).toBe('Under a minute')
  expect(aboutMinutes(300)).toBe('About 5 min')
  expect(aboutMinutes(326)).toBe('About 6 min')
})

it('shortens a long file name in the middle, keeping its start and extension', () => {
  expect(shortFileName('my_holiday_footage_from_the_beach_2024_final_version_v2.mp4')).toBe(
    'my_holiday_foot…_v2.mp4',
  )
  expect(shortFileName('a_very_long_name_without_any_extension_at_all')).toBe('a_very_long_nam…_at_all')
  expect(shortFileName('street.mp4')).toBe('street.mp4')
  expect(shortFileName('exactly_twenty_three.mp')).toBe('exactly_twenty_three.mp')
})

it('shows the tenth a time was set at, though sums land a hair under it', () => {
  expect(formatTime(3.4, true)).toBe('0:03.4')
  expect(formatTime(1 + 2.8, true)).toBe('0:03.8')
  expect(formatTime(73.65, true)).toBe('1:13.6')
  expect(formatTime(59.95)).toBe('0:59')
  expect(formatTime(125.04, true)).toBe('2:05.0')
})

it('shows the hundredth the playhead was set at in the transport', () => {
  expect(formatTimecode(3.8)).toBe('00:03.80')
  expect(formatTimecode(1 + 2.8)).toBe('00:03.80')
  expect(formatTimecode(62.3)).toBe('01:02.30')
  expect(formatTimecode(59.999)).toBe('00:59.99')
  expect(formatTimecode(125.04)).toBe('02:05.04')
})

it('words undo labels for the tooltips: a leading verb lowered, names and features naming their step as they are', () => {
  expect(undoAction('Remove Night city')).toBe('remove Night city')
  expect(undoAction('Delete 1 clip and 1 lyric line')).toBe('delete 1 clip and 1 lyric line')
  expect(undoAction('Remove transition: Flash')).toBe('remove transition: Flash')
  expect(undoAction('Director: a rainy city at dawn')).toBe('Director: a rainy city at dawn')
  expect(undoAction('Ask: Added a title at the start')).toBe('Ask: Added a title at the start')
  expect(undoAction('Auto-cut: 12 cuts')).toBe('Auto-cut: 12 cuts')
  expect(undoAction('VJ take 2')).toBe('VJ take 2')
})

it.each([
  [[], 'Show Me'],
  [['Show Me'], 'Show Me (2)'],
  [['Show Me', 'Show Me (2)', 'Show Me (4)'], 'Show Me (3)'],
  [['Show Me (2)'], 'Show Me'],
])('names a project "Show Me" next to %j as %s, which exports under its own file name', (taken, name) => {
  expect(distinctName('Show Me', taken)).toBe(name)
  if (taken.length) expect(exportFileName(name)).not.toBe(exportFileName(taken[0]!))
})

it('words the note for a search that finds nothing by how many words it has', () => {
  expect(noMatch('action')('replace')).toBe('No matching action. Try another word.')
  expect(noMatch('action')('  replace  ')).toBe('No matching action. Try another word.')
  expect(noMatch('shortcut')('replace clip')).toBe('No matching shortcut. Try fewer words.')
})
