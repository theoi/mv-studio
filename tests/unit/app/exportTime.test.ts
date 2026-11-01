import { describe, expect, it } from 'vitest'
import { timeLabel } from '../../../src/app/screens/export/outputs.ts'

describe('the export time label', () => {
  it.each([
    [null, 'Working out the time…'],
    [59, 'Under a minute on this device'],
    [61, 'About 2 min on this device'],
    [600, 'About 10 min on this device'],
    [601, 'About 11 min on this device'],
  ])('for %s s says %s, rounding up so it is never under the estimate', (seconds, label) => {
    expect(timeLabel(seconds)).toBe(label)
  })
})
