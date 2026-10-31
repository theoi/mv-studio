import { describe, expect, it } from 'vitest'
import { beatThisPeaks } from '../../../src/analysis/beats/beatThis.ts'
import { dpBeatTrack } from '../../../src/analysis/beats/dp.ts'
import { analyzeMono } from '../../../src/analysis/beats/fast.ts'
import {
  bpmFromBeats,
  fitDownbeats,
  gridPoints,
  inferBarPositions,
  makeGrid,
  nearestBeatIndex,
  rescaleGrid,
  setDownbeat,
  snapToGrid,
} from '../../../src/analysis/beats/grid.ts'
import { refineWithBeatThis } from '../../../src/analysis/beats/refine.ts'
import { chordPad, drumLoop, fmeasure, mix } from './synth.ts'

describe('fast beat tracking on synthetic drums', () => {
  it.each([92, 120, 128, 140])('finds %i BPM and its beats', (bpm) => {
    const { audio, beats } = drumLoop({ bpm, seconds: 40, offset: 0.37 })
    const { grid } = analyzeMono(mix(audio, chordPad([[60, 64, 67]], bpm, 40, 0.37)))
    expect(grid.source).toBe('dsp')
    expect(Math.abs(grid.bpm - bpm) / bpm).toBeLessThan(0.02)
    expect(fmeasure(grid.beats, beats)).toBeGreaterThan(0.95)
    expect(grid.barPositions).toHaveLength(grid.beats.length)
    expect(grid.downbeatsReliable).toBe(false)
  })

  it('is deterministic', () => {
    const { audio } = drumLoop({ bpm: 110, seconds: 20 })
    expect(analyzeMono(audio).grid).toEqual(analyzeMono(audio).grid)
  })

  it('follows a tempo change with a per-frame period', () => {
    const { audio, beats } = drumLoop({ bpm: 100, seconds: 40, tempoChanges: [[20, 112]] })
    const { onset } = analyzeMono(audio)
    const period = new Float64Array(onset.length).map((_, f) => (f < 2000 ? 60 : 53.57))
    const est = dpBeatTrack(onset, period).map((f) => f / 100 + 0.02)
    expect(fmeasure(est, beats)).toBeGreaterThan(0.9)
  })
})

describe('bar positions', () => {
  it('locks onto a 4/4 downbeat pattern with a pickup', () => {
    const like = Array.from({ length: 40 }, (_, i) => ((i - 1) % 4 === 0 ? 0.8 : 0.2))
    const r = inferBarPositions(like)
    expect(r.beatsPerBar).toBe(4)
    expect(r.positions.slice(0, 6)).toEqual([4, 1, 2, 3, 4, 1])
  })

  it('detects 3/4 when the evidence is clear', () => {
    const like = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 0.9 : 0.1))
    expect(inferBarPositions(like).beatsPerBar).toBe(3)
  })
})

describe('grid helpers', () => {
  const beats = Array.from({ length: 17 }, (_, i) => 1 + i * 0.5)
  const grid = makeGrid(
    'dsp',
    beats,
    { beatsPerBar: 4, positions: beats.map((_, i) => (i % 4) + 1) },
    [],
    false,
  )

  it('computes tempo and downbeats', () => {
    expect(grid.bpm).toBeCloseTo(120, 5)
    expect(grid.downbeats).toEqual([1, 3, 5, 7, 9])
    expect(grid.steady).toBe(true)
    expect(bpmFromBeats([])).toBe(0)
  })

  it('snaps to beats, subdivisions and bars', () => {
    expect(snapToGrid(grid, 1.2)).toBe(1)
    expect(snapToGrid(grid, 1.2, 4)).toBeCloseTo(1.25, 9)
    expect(snapToGrid(grid, 2.2, 0.25)).toBe(3)
    expect(gridPoints(grid, 2)).toHaveLength(33)
    expect(nearestBeatIndex(grid, 100)).toBe(16)
  })

  it('doubles, halves and re-anchors the grid', () => {
    const d = rescaleGrid(grid, 2)
    expect(d.bpm).toBeCloseTo(240, 5)
    expect(d.beatsPerBar).toBe(8)
    expect(d.downbeats).toEqual(grid.downbeats)
    const h = rescaleGrid(grid, 0.5)
    expect(h.bpm).toBeCloseTo(60, 5)
    expect(h.downbeats).toEqual(grid.downbeats)
    const s = setDownbeat(grid, 1)
    expect(s.downbeats[0]).toBe(1.5)
    expect(s.downbeatsReliable).toBe(true)
  })

  it('puts bars found on another grid on these beats, when they fall on them', () => {
    // Refined bars a few ms off these beats, and one before the first beat.
    expect(fitDownbeats(beats, [0.2, 1.02, 2.97, 5.01, 7.04, 9])).toEqual([1, 3, 5, 7, 9])
    // At twice the tempo (beats every 0.25 s) a bar 66 ms off is more than a quarter beat away.
    expect(fitDownbeats(rescaleGrid(grid, 2).beats, [1.066, 3.066, 5.066])).toBeNull()
    expect(fitDownbeats(rescaleGrid(grid, 2).beats, [1.05, 3.05, 5.05])).toEqual([1, 3, 5])
    // Bars on the off-beats (another phase) do not fit.
    expect(fitDownbeats(beats, [1.25, 3.25, 5.25, 7.25])).toBeNull()
    expect(fitDownbeats(beats, [1, 3.25, 5.25, 7.25, 9.25])).toBeNull()
    expect(fitDownbeats(beats, [3])).toBeNull()
    expect(fitDownbeats([1], [1])).toBeNull()
  })
})

describe('Beat This! refinement', () => {
  function fakeLogits(beatTimes: number[], downTimes: number[], frames: number, dropEveryOther = false) {
    const beat = new Float32Array(frames).fill(-6)
    const downbeat = new Float32Array(frames).fill(-6)
    beatTimes.forEach((t, i) => {
      if (dropEveryOther && i % 2 === 1 && t > 30) return
      const f = Math.round(t * 50)
      if (f < frames) {
        beat[f] = 5
        if (f > 0) beat[f - 1] = 0.5
      }
    })
    for (const t of downTimes) {
      const f = Math.round(t * 50)
      if (f < frames) downbeat[f] = 5
    }
    return { fps: 50, beat, downbeat }
  }

  it('keeps one beat level when Beat This! drops to half time mid-song', () => {
    const beats = Array.from({ length: 120 }, (_, i) => 0.5 + i * 0.4)
    const down = beats.filter((_, i) => i % 4 === 0)
    const logits = fakeLogits(beats, down, 2600, true)
    expect(beatThisPeaks(logits.beat).length).toBeLessThan(110)
    const grid = refineWithBeatThis(logits, { dspBpm: 150 })
    expect(grid.source).toBe('beat-this')
    expect(Math.abs(grid.bpm - 150)).toBeLessThan(1.5)
    expect(fmeasure(grid.beats, beats)).toBeGreaterThan(0.97)
    expect(fmeasure(grid.downbeats, down)).toBeGreaterThan(0.95)
  })

  it('trusts a consistent Beat This! level over a double-time DSP estimate', () => {
    const beats = Array.from({ length: 100 }, (_, i) => 0.3 + i * 0.6)
    const logits = fakeLogits(
      beats,
      beats.filter((_, i) => i % 4 === 0),
      3100,
    )
    const grid = refineWithBeatThis(logits, { dspBpm: 200 })
    expect(Math.abs(grid.bpm - 100)).toBeLessThan(1)
    expect(grid.downbeatsReliable).toBe(true)
  })
})
