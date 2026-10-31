import { describe, expect, it } from 'vitest'
import { energySampler } from '../../../src/app/screens/editor/timeline/energy.ts'

const series = (values: number[], rate = 10) => ({ rate, values })

describe('energy curve on the song lane', () => {
  it('draws beat-to-beat swings as a level curve instead of a zigzag', () => {
    const at = energySampler(series(Array.from({ length: 600 }, (_, i) => i % 2)))
    const drawn = Array.from({ length: 200 }, (_, k) => at(5 + k * 0.25, 0.01))
    expect(Math.min(...drawn)).toBeGreaterThan(0.43)
    expect(Math.max(...drawn)).toBeLessThan(0.57)
  })

  it('keeps a change in energy between sections', () => {
    const at = energySampler(series(Array.from({ length: 600 }, (_, i) => (i < 300 ? 0.2 : 0.8))))
    expect(at(20, 0.01)).toBeCloseTo(0.2)
    expect(at(30, 0.01)).toBeCloseTo(0.5)
    expect(at(40, 0.01)).toBeCloseTo(0.8)
  })

  it('counts every sample once when a column spans many of them', () => {
    const values = Array.from({ length: 1200 }, (_, i) => Math.abs(Math.sin(i * 1.7)))
    const at = energySampler(series(values))
    const column = 6
    const columns = Array.from({ length: 120 / column }, (_, k) => at(column / 2 + k * column, column))
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(columns.reduce((a, b) => a + b, 0) / columns.length).toBeCloseTo(mean, 6)
  })

  it('is zero outside the song', () => {
    const at = energySampler(series([0.5, 0.5, 0.5]))
    expect(at(-2, 0.01)).toBe(0)
    expect(at(2, 0.01)).toBe(0)
  })
})
