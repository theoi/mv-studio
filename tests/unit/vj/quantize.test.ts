import { describe, expect, it } from 'vitest'
import {
  beatGridOf,
  nearestGridTime,
  quantizeEvents,
  quantizeTime,
  type BeatGrid,
} from '../../../src/vj/index.ts'
import { makeProject } from './helpers.ts'

describe('beat grid', () => {
  it('maps analysed beats through the song clip onto the timeline', () => {
    const project = makeProject()
    const clip = project.clips['song-clip']!
    project.clips['song-clip'] = { ...clip, start: 2, sourceStart: 1, duration: 10 } as typeof clip
    const grid = beatGridOf(project)!
    expect(grid.beats.slice(0, 3)).toEqual([2, 2.5, 3])
    expect(grid.beats.at(-1)).toBe(12)
    expect(grid.downbeats?.[0]).toBe(3)
  })

  it('falls back to the tempo, and is null without analysis', () => {
    const project = makeProject()
    project.analysis.audio.song = { assetId: 'song', version: 't', tempo: { bpm: 100, confidence: 1 } }
    expect(beatGridOf(project)?.beats.slice(0, 2)).toEqual([0, 0.6])
    project.analysis.audio = {}
    expect(beatGridOf(project)).toBeNull()
  })
})

describe('quantize', () => {
  // A tempo change: 0.5 s beats, then 0.4 s beats from 2 s.
  const grid: BeatGrid = { beats: [0, 0.5, 1, 1.5, 2, 2.4, 2.8, 3.2], downbeats: [0, 2, 3.2] }

  it('snaps to beats, subdivisions and bars, following tempo changes and extending past the ends', () => {
    expect(nearestGridTime(0.62, grid, '1/4')).toBe(0.5)
    expect(nearestGridTime(0.62, grid, '1/8')).toBe(0.5)
    expect(nearestGridTime(0.7, grid, '1/8')).toBe(0.75)
    expect(nearestGridTime(2.12, grid, '1/16')).toBeCloseTo(2.1, 9)
    expect(nearestGridTime(0.3, grid, '1/8T')).toBeCloseTo(1 / 3, 9)
    expect(nearestGridTime(1.2, grid, 'bar')).toBe(2)
    expect(nearestGridTime(3.75, grid, '1/4')).toBeCloseTo(3.6, 9)
    expect(nearestGridTime(-0.4, grid, '1/4')).toBe(-0.5)
  })

  it('moves part of the way with a lower strength', () => {
    expect(quantizeTime(0.6, grid, { enabled: true, grid: '1/4', strength: 0.5 })).toBeCloseTo(0.55, 9)
  })

  it('keeps knob moves and the starting state in place and never collapses a held pad', () => {
    const settings = { enabled: true, grid: '1/4' as const, strength: 1 }
    const out = quantizeEvents(
      [
        { t: 0.2, type: 'press', pad: 'start', velocity: 1 },
        { t: 0.9, type: 'press', pad: 'a', velocity: 1 },
        { t: 0.95, type: 'amount', pad: 'a', value: 0.3 },
        { t: 1.1, type: 'release', pad: 'a' },
        { t: 1.6, type: 'press', pad: 'b', velocity: 1 },
      ],
      grid,
      settings,
      0.2,
      1 / 30,
    )
    expect(out.map((e) => [e.pad, e.type, Math.round(e.t * 1000) / 1000])).toEqual([
      ['start', 'press', 0.2],
      ['a', 'amount', 0.95],
      ['a', 'press', 1],
      ['a', 'release', 1.2],
      ['b', 'press', 1.5],
    ])
  })
})
