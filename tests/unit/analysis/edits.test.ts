import { describe, expect, it } from 'vitest'
import { fitTappedTempo, keepUserSections, moveDownbeat, rescaleTempo } from '../../../src/analysis/edits.ts'
import type { AudioAnalysis, SongSection } from '../../../src/model/types.ts'

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
  it('doubles the beat level, keeping bars of four: a bar also starts halfway through each', () => {
    const edit = rescaleTempo(analysis, 2)
    expect(edit).toMatchObject({ type: 'analysis.setGrid', assetId: 'a' })
    const doubled = edit.grid
    expect(doubled.tempo).toEqual({ bpm: 240, confidence: 1 })
    expect(doubled.beats).toHaveLength(31)
    expect(doubled.beats?.[1]).toBe(1.25)
    // The last bar ran on to the end of the song, so a bar starts four beats after its start too.
    expect(doubled.downbeats).toEqual(beats.filter((_, i) => i % 2 === 1))
  })

  it('starts a bar four beats before the first one when doubling leaves a pickup of a bar or more', () => {
    // Three pickup beats become six: the first bar of four starts on the third of them.
    const { grid } = rescaleTempo({ ...analysis, downbeats: beats.filter((_, i) => i % 4 === 3) }, 2)
    expect(grid.downbeats).toEqual(beats.filter((_, i) => i % 2 === 1))
  })

  it('starts a bar every four beats when doubling across a bar start that was missed', () => {
    const long = Array.from({ length: 32 }, (_, i) => 1 + i * 0.5)
    const missed = long.filter((_, i) => i % 4 === 1 && i !== 9)
    const { grid } = rescaleTempo({ ...analysis, beats: long, downbeats: missed }, 2)
    expect(grid.downbeats).toEqual(long.filter((_, i) => i % 2 === 1))
  })

  it('halves the beat level, leaving no bars, since which half of each bar starts one is unknown', () => {
    const { grid: halved } = rescaleTempo(analysis, 0.5)
    expect(halved.tempo?.bpm).toBeCloseTo(60, 5)
    expect('downbeats' in halved && halved.downbeats === undefined).toBe(true)
    expect(halved.beats).toEqual(beats.filter((_, i) => i % 2 === 1))
  })

  it('keeps the bars when halving beats whose bars span eight of them', () => {
    const { grid } = rescaleTempo({ ...analysis, downbeats: beats.filter((_, i) => i % 8 === 1) }, 0.5)
    expect(grid.downbeats).toEqual(beats.filter((_, i) => i % 8 === 1))
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

const sec = (id: string, start: number, end: number, label: string, extra: Partial<SongSection> = {}) => ({
  id,
  start,
  end,
  label,
  ...extra,
})

describe('keeping the sections the user named across a new analysis', () => {
  const fresh: SongSection[] = [
    sec('f1', 0, 10, 'intro', { repeatGroup: 0 }),
    sec('f2', 10, 30, 'verse', { repeatGroup: 1 }),
    sec('f3', 30, 50, 'chorus', { repeatGroup: 2, confidence: 0.4 }),
    sec('f4', 50, 60, 'outro', { repeatGroup: 3 }),
  ]

  it('returns the new sections when the user named none', () => {
    const previous = [sec('p1', 0, 25, 'verse', { confidence: 0.4 }), sec('p2', 25, 60, 'chorus')]
    expect(keepUserSections(fresh, previous)).toEqual(fresh)
  })

  it('keeps a named section as it was and cuts the new sections around it', () => {
    const solo = sec('p2', 25, 42, 'Guitar solo', { repeatGroup: 7, confidence: 1, energy: 0.8 })
    const out = keepUserSections(fresh, [sec('p1', 0, 25, 'verse'), solo])
    expect(out.map((s) => [s.label, s.start, s.end])).toEqual([
      ['intro', 0, 10],
      ['verse', 10, 25],
      ['Guitar solo', 25, 42],
      ['chorus', 42, 50],
      ['outro', 50, 60],
    ])
    // Its name, id and energy stay; it takes the group of the new section it mostly covers (the chorus, 12 s of 17).
    expect(out[2]).toEqual({ ...solo, repeatGroup: 2 })
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length)
  })

  it('cuts a new section in two around a named section inside it, with distinct ids', () => {
    const out = keepUserSections(fresh, [sec('p', 15, 20, 'Spoken', { confidence: 1 })])
    expect(out.map((s) => [s.id, s.label, s.start, s.end]).slice(1, 4)).toEqual([
      ['f2', 'verse', 10, 15],
      ['p', 'Spoken', 15, 20],
      ['f2.1', 'verse', 20, 30],
    ])
  })

  it('joins a new piece shorter than a second to its new neighbour', () => {
    // The named section ends 0.5 s before the chorus starts: that sliver of verse joins the chorus.
    const out = keepUserSections(fresh, [sec('p', 5, 29.5, 'Story', { confidence: 1 })])
    expect(out.map((s) => [s.label, s.start, s.end])).toEqual([
      ['intro', 0, 5],
      ['Story', 5, 29.5],
      ['chorus', 29.5, 50],
      ['outro', 50, 60],
    ])
  })

  it('gives a new piece an id no kept or new section has', () => {
    const out = keepUserSections(fresh, [sec('f2.1', 15, 20, 'Spoken', { confidence: 1 })])
    expect(out.map((s) => [s.id, s.label, s.start, s.end]).slice(1, 4)).toEqual([
      ['f2', 'verse', 10, 15],
      ['f2.1', 'Spoken', 15, 20],
      ['f2.2', 'verse', 20, 30],
    ])
  })

  it('keeps a section whose name the analysis never gives, also without a confidence (older projects)', () => {
    const out = keepUserSections(fresh, [
      sec('p', 15, 20, 'Hook'),
      sec('q', 32, 40, 'chorus', { confidence: 0.8 }),
    ])
    expect(out.map((s) => [s.label, s.start, s.end]).slice(1, 4)).toEqual([
      ['verse', 10, 15],
      ['Hook', 15, 20],
      ['verse', 20, 30],
    ])
    expect(out.some((s) => s.id === 'q')).toBe(false)
  })

  it('keeps a section whose edges the user dragged, though its name came from the analysis', () => {
    const moved = sec('p', 12, 27, 'verse', { confidence: 0.4, edited: ['start', 'end'] })
    expect(keepUserSections(fresh, [moved]).map((s) => [s.id, s.label, s.start, s.end])).toEqual([
      ['f1', 'intro', 0, 10],
      ['f2', 'verse', 10, 12],
      ['p', 'verse', 12, 27],
      ['f2.1', 'verse', 27, 30],
      ['f3', 'chorus', 30, 50],
      ['f4', 'outro', 50, 60],
    ])
  })
})
