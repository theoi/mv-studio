import { describe, expect, it } from 'vitest'
import { timeLabel } from '../../../src/app/screens/export/outputs.ts'

describe('the export time label', () => {
  it.each([
    [null, 'Working out the time…'],
    [59, 'Under a minute on this device'],
    [61, 'About 2 min on this device'],
    [600, 'About 10 min on this device'],
    [601, 'About 11 min on this device'],
    [1213, 'About 21 min on this device'],
    [20 * 60, 'About 20 min on this device'],
    [55 * 60 + 1, 'About 56 min on this device'],
    [3600, 'About 1 h on this device'],
    [3601, 'About 1 h 5 min on this device'],
    [123 * 60, 'About 2 h 10 min on this device'],
    [137 * 60, 'About 2 h 20 min on this device'],
    [10 * 3600 + 1, 'About 10 h 10 min on this device'],
  ])('for %s s says %s, rounding up so it is never under the estimate', (seconds, label) => {
    expect(timeLabel(seconds)).toBe(label)
  })

  it('adds at most about a tenth to estimates from 10 minutes up', () => {
    const minutes = Array.from({ length: 600 }, (_, i) => 10 + i * 0.5)
    const added = minutes.map((m) => {
      const label = timeLabel(m * 60)
      const [, h, min] = /About (?:(\d+) h)? ?(?:(\d+) min)?/.exec(label) ?? []
      return (Number(h ?? 0) * 60 + Number(min ?? 0)) / m
    })
    expect(added.length).toBe(600)
    expect(Math.min(...added)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...added)).toBeLessThanOrEqual(1.1)
  })

  it('says why it has no figure yet while the time waits for other tasks', () => {
    expect(timeLabel(null, { waitingForJobs: true })).toBe('Timing once other tasks finish…')
  })

  it.each([
    [1213, 'Up to 21 min on this device'],
    [3601, 'Up to 1 h 5 min on this device'],
    [59, 'Under a minute on this device'],
  ])('for %s s timed under load says %s until it is timed again', (seconds, label) => {
    expect(timeLabel(seconds, { provisional: true })).toBe(label)
  })
})
