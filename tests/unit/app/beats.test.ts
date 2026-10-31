import { describe, expect, it } from 'vitest'
import { createProject, createVideoClip, type AudioAnalysis, type Project } from '../../../src/model/index.ts'
import {
  barAt,
  barsBetween,
  beatAt,
  beatGrid,
  snapTo,
  type SnapOptions,
} from '../../../src/app/state/beats.ts'
import { timelineDuration } from '../../../src/app/state/project.ts'

function song(analysis: Partial<AudioAnalysis>): Project {
  const p = createProject({ name: 'beats' })
  p.songAssetId = 'song'
  p.analysis.audio.song = { assetId: 'song', version: 'v1', ...analysis }
  return p
}

/** A waltz: beats every 0.5 s from 0.25 s, a bar start every 3 beats. */
const beats = Array.from({ length: 40 }, (_, i) => 0.25 + i * 0.5)
const downbeats = beats.filter((_, i) => i % 3 === 0)
const waltz = song({ tempo: { bpm: 120, confidence: 1 }, beats, downbeats })

describe('beat grid', () => {
  it('takes the meter and bar starts from the detected downbeats', () => {
    const grid = beatGrid(waltz)
    expect(grid).toMatchObject({ beatsPerBar: 3, detectedBars: true, beat: 0.5 })
    expect(grid?.downbeats).toEqual(downbeats)
    expect(grid?.beats).toEqual(beats)
  })

  it('has no bars until they are found: no bar starts, bar readout or bar count, and the beat counts instead', () => {
    const grid = beatGrid(song({ beats }))!
    expect(grid).toMatchObject({ beatsPerBar: 4, detectedBars: false, downbeats: [] })
    expect(barAt(grid, 3)).toBeNull()
    expect(beatAt(grid, 0.3)).toBe(1)
    expect(beatAt(grid, 3)).toBe(6)
    expect(barsBetween(grid, 0, 8)).toBeNull()
    const barsOnly: SnapOptions = {
      snap: true,
      beatSnap: false,
      barSnap: true,
      sectionSnap: false,
      edgeSnap: false,
      playheadSnap: false,
    }
    expect(snapTo(1.9, 0.3, grid, barsOnly, {}).snapped).toBeNull()
    expect(snapTo(1.9, 0.3, beatGrid(waltz), barsOnly, {}).snapped).toBe(1.75)
  })

  it('counts beats from 0 s at the tempo when no beats were found', () => {
    const p = song({ tempo: { bpm: 100, confidence: 1 } })
    const clip = createVideoClip({ trackId: p.tracks[0]!.id, assetId: 'v', start: 0, duration: 20 })
    p.clips[clip.id] = clip
    const grid = beatGrid(p)
    expect(grid?.beats.slice(0, 3)).toEqual([0, 0.6, 1.2])
    expect(grid?.beats.at(-1)).toBeGreaterThan(timelineDuration(p) - 0.6)
    expect(beatGrid(song({}))).toBeNull()
  })

  it('stays the same object when another part of the analysis changes, as a section drag does', () => {
    const a = waltz.analysis.audio.song!
    const edited = { ...waltz, analysis: { ...waltz.analysis, audio: { song: { ...a, sections: [] } } } }
    expect(beatGrid(edited)).toBe(beatGrid(waltz))
  })

  it.each([
    [0.1, 1, 1],
    [0.3, 1, 1],
    [1.3, 1, 3],
    [1.8, 2, 1],
    [3.0, 2, 3],
    [3.3, 3, 1],
  ])('at %s s it is bar %s, beat %s', (t, bar, beat) => {
    expect(barAt(beatGrid(waltz)!, t)).toEqual({ bar, beat })
  })

  it('counts the bars of a stretch by its bar starts', () => {
    expect(barsBetween(beatGrid(waltz), 1.75, 1.75 + 4 * 1.5)).toBe(4)
    expect(barsBetween(null, 0, 8)).toBeNull()
  })
})

describe('snapping', () => {
  const all: SnapOptions = {
    snap: true,
    beatSnap: true,
    barSnap: true,
    sectionSnap: true,
    edgeSnap: true,
    playheadSnap: true,
  }
  const grid = beatGrid(waltz)

  it('snaps to the nearest beat, bar start, clip edge, section edge or playhead within the tolerance', () => {
    expect(snapTo(2.2, 0.2, grid, all, {})).toEqual({ t: 2.25, snapped: 2.25 })
    expect(snapTo(2.2, 0.2, grid, all, { edges: [2.18] })).toEqual({ t: 2.18, snapped: 2.18 })
    expect(snapTo(2.2, 0.2, grid, all, { sections: [2.21] }).t).toBe(2.21)
    expect(snapTo(2.2, 0.2, grid, all, { playhead: 2.19 }).t).toBe(2.19)
    expect(snapTo(2.0, 0.1, grid, all, {})).toEqual({ t: 2.0, snapped: null })
  })

  it('leaves out what the snap menu turns off', () => {
    const t = 2.2
    expect(snapTo(t, 0.2, grid, { ...all, snap: false }, { edges: [2.2] }).snapped).toBeNull()
    expect(snapTo(t, 0.5, grid, { ...all, beatSnap: false }, {}).t).toBe(1.75)
    expect(snapTo(t, 0.5, grid, { ...all, beatSnap: false, barSnap: false }, {}).snapped).toBeNull()
    expect(snapTo(t, 0.2, grid, { ...all, edgeSnap: false }, { edges: [2.18] }).t).toBe(2.25)
    expect(snapTo(t, 0.2, grid, { ...all, sectionSnap: false }, { sections: [2.21] }).t).toBe(2.25)
    expect(snapTo(t, 0.2, grid, { ...all, playheadSnap: false }, { playhead: 2.19 }).t).toBe(2.25)
  })
})
