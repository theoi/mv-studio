import { describe, expect, it } from 'vitest'
import { analyzeMono } from '../../../src/analysis/beats/fast.ts'
import {
  analyzeStructure,
  computeEnergyCurve,
  labelSections,
} from '../../../src/analysis/structure/sections.ts'
import { drumLoop } from './synth.ts'

/** Raw segments from consecutive [group, energy, seconds] triples. */
function segments(spec: [number, number, number][]) {
  let t = 0
  return spec.map(([group, energy, seconds]) => {
    const s = { start: t, end: t + seconds, group, energy }
    t += seconds
    return s
  })
}

describe('analyzeStructure', () => {
  it('does not split off a beat at the very end of a clip as its own section', () => {
    const { audio } = drumLoop({ bpm: 120, seconds: 8, offset: 0.5 })
    const { spec, onset } = analyzeMono(audio)
    const beats = [...Array.from({ length: 15 }, (_, i) => 0.5 + i * 0.5), 7.99]
    const grid = { beats, barPositions: beats.map((_, i) => (i % 4) + 1) }
    const { sections } = analyzeStructure(spec, grid, computeEnergyCurve(spec, onset))
    expect(sections.map((s) => [s.start, s.end])).toEqual([[0, 8]])
  })
})

describe('labelSections', () => {
  it('labels a typical pop form from repetition, energy and position', () => {
    const raw = segments([
      [0, 0.2, 8],
      [1, 0.45, 16],
      [2, 0.85, 16],
      [1, 0.45, 16],
      [2, 0.85, 16],
      [3, 0.5, 16],
      [2, 0.9, 16],
      [4, 0.2, 8],
    ])
    const { sections, chorus } = labelSections(raw, 112)
    expect(sections.map((s) => s.label)).toEqual([
      'intro',
      'verse',
      'chorus',
      'verse',
      'chorus',
      'bridge',
      'chorus',
      'outro',
    ])
    expect(chorus.map((c) => c.start)).toEqual([24, 56, 88])
  })

  it('prefers the group that follows the verse as chorus when energies are equal', () => {
    const raw = segments([
      [0, 0.6, 16],
      [1, 0.6, 16],
      [0, 0.6, 16],
      [1, 0.6, 16],
      [0, 0.6, 16],
      [1, 0.6, 16],
    ])
    expect(labelSections(raw, 96).sections.map((s) => s.label)).toEqual([
      'verse',
      'chorus',
      'verse',
      'chorus',
      'verse',
      'chorus',
    ])
  })

  it('labels a song with a single segment as a verse', () => {
    expect(labelSections(segments([[0, 0.5, 30]]), 30).sections.map((s) => s.label)).toEqual(['verse'])
  })

  it('merges neighbouring segments with the same label and averages their energy', () => {
    const raw = segments([
      [0, 0.4, 16],
      [1, 0.8, 16],
      [0, 0.4, 16],
      [0, 0.3, 10],
      [1, 0.8, 16],
      [1, 0.9, 16],
    ])
    const { sections } = labelSections(raw, 90)
    expect(sections.map((s) => [s.label, s.start, s.end])).toEqual([
      ['verse', 0, 16],
      ['chorus', 16, 32],
      ['verse', 32, 58],
      ['chorus', 58, 90],
    ])
    expect(sections[3]?.energy).toBeCloseTo(0.85, 3)
  })
})
