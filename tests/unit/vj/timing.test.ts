import { describe, expect, it } from 'vitest'
import { estimateInputOffset, inputTimelineTime } from '../../../src/vj/index.ts'

describe('inputTimelineTime', () => {
  it('rewinds the heard clock time to when the input arrived, minus the calibrated offset', () => {
    expect(inputTimelineTime({ clockTime: 10, playing: true, now: 5000, eventTime: 4980 })).toBeCloseTo(
      9.98,
      9,
    )
    expect(
      inputTimelineTime({ clockTime: 10, playing: true, now: 5000, eventTime: 4980, offsetMs: 15 }),
    ).toBeCloseTo(9.965, 9)
  })

  it('ignores timestamps that are stale, from the future or missing, and does not rewind while paused', () => {
    expect(inputTimelineTime({ clockTime: 10, playing: true, now: 5000, eventTime: 4000 })).toBe(10)
    expect(inputTimelineTime({ clockTime: 10, playing: true, now: 5000, eventTime: 5010 })).toBe(10)
    expect(inputTimelineTime({ clockTime: 10, playing: true, now: 5000, eventTime: Number.NaN })).toBe(10)
    expect(
      inputTimelineTime({ clockTime: 10, playing: false, now: 5000, eventTime: 4980, offsetMs: 50 }),
    ).toBe(10)
  })
})

describe('estimateInputOffset', () => {
  const beats = Array.from({ length: 40 }, (_, i) => i * 0.5)

  it('measures how late taps land, ignoring stray taps', () => {
    const jitter = [0.004, -0.003, 0.002, -0.001, 0.003, -0.004, 0, 0.001]
    const taps = jitter.map((j, i) => 2 + i * 0.5 + 0.03 + j)
    const estimate = estimateInputOffset([...taps, 7.24], beats)
    expect(estimate?.offsetMs).toBeCloseTo(30.5, 0)
    expect(estimate?.used).toBe(8)
    expect(estimate!.spreadMs).toBeLessThan(5)
  })

  it('needs at least four taps and a beat grid', () => {
    expect(estimateInputOffset([1, 1.5, 2], beats)).toBeNull()
    expect(estimateInputOffset([1, 1.5, 2, 2.5], [1])).toBeNull()
  })
})
