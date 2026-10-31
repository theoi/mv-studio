import { describe, expect, it } from 'vitest'
import { tapTempo } from '../../../src/analysis/beats/tap.ts'

const taps = (bpm: number, n: number, from = 10) => Array.from({ length: n }, (_, i) => from + (i * 60) / bpm)

describe('tapTempo', () => {
  it('needs four taps', () => {
    expect(tapTempo(taps(120, 3))).toBeNull()
    expect(tapTempo(taps(120, 4))).toBe(120)
  })

  it('averages out uneven taps', () => {
    const jitter = [0, 0.03, -0.02, 0.025, -0.03, 0.01, -0.015, 0.02]
    expect(tapTempo(taps(97, 8).map((t, i) => t + (jitter[i] as number)))).toBeCloseTo(97, 0)
  })

  it('uses the median beat when a tap was missed', () => {
    const missed = taps(100, 9).filter((_, i) => i !== 4)
    expect(tapTempo(missed)).toBe(100)
  })

  it('starts counting again after a pause', () => {
    expect(tapTempo([...taps(80, 6, 0), ...taps(140, 5, 20)])).toBe(140)
    expect(tapTempo([...taps(80, 6, 0), ...taps(140, 3, 20)])).toBeNull()
  })
})
