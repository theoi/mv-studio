import { describe, expect, it } from 'vitest'
import { fitTappedTempo, moveDownbeat, rescaleTempo } from '../../../src/analysis/edits.ts'
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
    const edit = rescaleTempo(analysis, 2)
    expect(edit).toMatchObject({ type: 'analysis.setGrid', assetId: 'a' })
    const doubled = edit.grid
    expect(doubled.tempo).toEqual({ bpm: 240, confidence: 1 })
    expect(doubled.beats).toHaveLength(31)
    expect(doubled.beats?.[1]).toBe(1.25)
    expect(doubled.downbeats).toEqual(analysis.downbeats)
  })

  it('halves the beat level, keeping downbeats', () => {
    const halved = rescaleTempo(analysis, 0.5).grid
    expect(halved.tempo?.bpm).toBeCloseTo(60, 5)
    expect(halved.downbeats).toEqual(analysis.downbeats)
    expect(halved.beats).toEqual(beats.filter((_, i) => i % 2 === 1))
  })

  it('keeps no downbeats when doubling or halving beats whose bars are not found yet', () => {
    const unbarred: AudioAnalysis = { ...analysis, downbeats: undefined }
    for (const factor of [2, 0.5] as const) {
      const { grid } = rescaleTempo(unbarred, factor)
      expect('downbeats' in grid).toBe(true)
      expect(grid.downbeats).toBeUndefined()
      expect(grid.beats?.length).toBe(factor === 2 ? 31 : 8)
    }
  })

  it('sets bars from the first beat when none were found yet', () => {
    const moved = moveDownbeat({ ...analysis, downbeats: undefined }, 1).grid
    expect(moved.downbeats).toEqual([1.5, 3.5, 5.5, 7.5])
  })

  it('moves the downbeat and renumbers the bars', () => {
    const moved = moveDownbeat(analysis, 2).grid
    expect(moved.downbeats).toEqual([2, 4, 6, 8])
    expect(moveDownbeat(analysis, 0, 3).grid.downbeats).toEqual([1, 2.5, 4, 5.5, 7, 8.5])
  })

  it('fits a tapped tempo to the beats found, at their level, twice or half of it', () => {
    expect(fitTappedTempo(analysis, 118)).toEqual({ kind: 'same' })
    const double = fitTappedTempo(analysis, 236)
    expect(double.kind === 'rescale' && double.edit.grid.tempo?.bpm).toBe(240)
    const half = fitTappedTempo(analysis, 61.5)
    expect(half.kind === 'rescale' && half.edit.grid.beats).toHaveLength(8)
    expect(fitTappedTempo(analysis, 90)).toEqual({ kind: 'retrack' })
    expect(fitTappedTempo({ ...analysis, beats: [] }, 120)).toEqual({ kind: 'retrack' })
  })

  it('reads the beat level from the beat intervals, so a skipped break does not lower it', () => {
    const gapped = [...beats.slice(0, 8), ...beats.slice(8).map((t) => t + 4)]
    const skipped = { ...analysis, tempo: { bpm: 96, confidence: 0.8 }, beats: gapped }
    expect(fitTappedTempo(skipped, 120)).toEqual({ kind: 'same' })
  })
})
