import { expect, it } from 'vitest'
import { shortFileName } from '../../../src/shared/text.ts'

it('shortens a long file name in the middle, keeping its start and extension', () => {
  expect(shortFileName('my_holiday_footage_from_the_beach_2024_final_version_v2.mp4')).toBe(
    'my_holiday_foot…_v2.mp4',
  )
  expect(shortFileName('a_very_long_name_without_any_extension_at_all')).toBe('a_very_long_nam…_at_all')
  expect(shortFileName('street.mp4')).toBe('street.mp4')
  expect(shortFileName('exactly_twenty_three.mp')).toBe('exactly_twenty_three.mp')
})
