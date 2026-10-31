import { describe, expect, it } from 'vitest'
import { moveDownbeat, rescaleTempo } from '../../../src/analysis/edits.ts'
import type { AudioAnalysis } from '../../../src/model/types.ts'

const beats = Array.from({ length: 16 }, (_, i) => 1 + i * 0.5)
const analysis: AudioAnalysis = {
  assetId: 'a',
  version: 'test',
  tempo: { bpm: 120, confidence: 0.4 },
  beats,
  // A pickup beat, then bars of four.
  downbeats: beats.filter((_, i) => i % 4 === 1),
}

describe('beat grid corrections', () => {
  it('doubles the beat level, keeping downbeats', () => {
    const doubled = rescaleTempo(analysis, 2)
    expect(doubled.tempo).toEqual({ bpm: 240, confidence: 1 })
    expect(doubled.beats).toHaveLength(31)
    expect(doubled.beats?.[1]).toBe(1.25)
    expect(doubled.downbeats).toEqual(analysis.downbeats)
  })

  it('halves the beat level, keeping downbeats', () => {
    const halved = rescaleTempo(analysis, 0.5)
    expect(halved.tempo?.bpm).toBeCloseTo(60, 5)
    expect(halved.downbeats).toEqual(analysis.downbeats)
    expect(halved.beats).toEqual(beats.filter((_, i) => i % 2 === 1))
  })

  it('moves the downbeat and renumbers the bars', () => {
    const moved = moveDownbeat(analysis, 2)
    expect(moved.downbeats).toEqual([2, 4, 6, 8])
    expect(moveDownbeat(analysis, 0, 3).downbeats).toEqual([1, 2.5, 4, 5.5, 7, 8.5])
  })
})
