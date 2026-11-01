import { describe, expect, it } from 'vitest'
import { timeLabel } from '../../../src/app/screens/export/outputs.ts'

describe('the export time label', () => {
  it.each([
    [null, 'Working out the time…'],
    [59, 'Under a minute on this device'],
    [61, 'About 2 min on this device'],
    [600, 'About 10 min on this device'],
    [601, 'About 15 min on this device'],
    [55 * 60 + 1, 'About 1 h on this device'],
    [3600, 'About 1 h on this device'],
    [3601, 'About 1 h 10 min on this device'],
    [123 * 60, 'About 2 h 10 min on this device'],
    [137 * 60, 'About 2 h 20 min on this device'],
    [10 * 3600 + 1, 'About 10 h 10 min on this device'],
  ])('for %s s says %s, rounding up so it is never under the estimate', (seconds, label) => {
    expect(timeLabel(seconds)).toBe(label)
  })
})
