import { describe, expect, it } from 'vitest'
import { ANALYZER_VERSION, analyzeSongFast, sectionFields } from '../../../src/analysis/song.ts'
import { JobError } from '../../../src/shared/jobs.ts'
import { chordPad, concat, drumLoop, fmeasure, mix, SR } from './synth.ts'

const BPM = 120
const VERSE = [
  [57, 60, 64],
  [53, 57, 60],
  [55, 59, 62],
  [52, 55, 59],
]
const CHORUS = [
  [60, 64, 67],
  [65, 69, 72],
  [67, 71, 74],
  [62, 65, 69],
]

/** 16 s parts: quiet verse (soft drums, minor pad) or loud chorus (full drums, major pad). */
function part(kind: 'verse' | 'chorus', seed: number) {
  const verse = kind === 'verse'
  const drums = drumLoop({ bpm: BPM, seconds: 16, offset: 0, seed, gain: verse ? 0.4 : 1 })
  return { audio: mix(drums.audio, chordPad(verse ? VERSE : CHORUS, BPM, 16, 0, verse ? 0.1 : 0.3)), drums }
}

function song() {
  const parts = [part('verse', 1), part('chorus', 2), part('verse', 3), part('chorus', 4), part('chorus', 5)]
  const beats = parts.flatMap((p, i) => p.drums.beats.map((t) => t + 16 * i))
  const mono = concat(...parts.map((p) => p.audio))
  return { mono, beats }
}

describe('analyzeSongFast', () => {
  const { mono, beats } = song()
  const progress: { stage?: string; fraction?: number }[] = []
  const { analysis } = analyzeSongFast(
    'song-1',
    { sampleRate: SR, channels: [mono, mono] },
    { onProgress: (p) => progress.push(p) },
  )

  it('finds tempo and beats and reports increasing progress', () => {
    expect(analysis.assetId).toBe('song-1')
    expect(analysis.version).toBe(ANALYZER_VERSION)
    expect(Math.abs((analysis.tempo?.bpm ?? 0) - BPM)).toBeLessThan(1)
    expect(fmeasure(analysis.beats ?? [], beats)).toBeGreaterThan(0.97)
    expect(analysis.downbeats?.every((d) => analysis.beats?.includes(d))).toBe(true)
    const fractions = progress.map((p) => p.fraction ?? 0)
    expect(fractions.length).toBeGreaterThan(3)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
  })

  it('finds verse and chorus sections that cover the song', () => {
    const sections = analysis.sections ?? []
    expect(sections.map((s) => s.label)).toEqual(['verse', 'chorus', 'verse', 'chorus'])
    expect(sections.map((s) => s.repeatGroup)).toEqual([0, 1, 0, 1])
    expect(sections[0]?.start).toBe(0)
    expect(sections.at(-1)?.end).toBeCloseTo(80, 1)
    sections.slice(1).forEach((s, i) => expect(s.start).toBe(sections[i]?.end))
    expect(sections.slice(1).map((s) => s.start)).toEqual([
      expect.closeTo(16, 1),
      expect.closeTo(32, 1),
      expect.closeTo(48, 1),
    ])
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length)
    const [verse, chorus] = sections
    expect(chorus?.energy ?? 0).toBeGreaterThan((verse?.energy ?? 1) + 0.3)
  })

  it('stores an energy curve and onsets on the drum hits', () => {
    expect(analysis.energy?.rate).toBe(10)
    expect(analysis.energy?.values.length).toBeCloseTo(800, -1)
    const onsets = analysis.features?.onsets ?? []
    const hits = beats.filter((t) => t > 0.2)
    const matched = hits.filter((t) => onsets.some((o) => Math.abs(o - t) <= 0.02))
    expect(matched.length / hits.length).toBeGreaterThan(0.95)
  })

  it('rejects audio without samples', () => {
    expect(() => analyzeSongFast('x', { sampleRate: SR, channels: [] })).toThrow(JobError)
  })

  it('stops when cancelled', () => {
    const controller = new AbortController()
    controller.abort(new JobError('cancelled', 'Cancelled'))
    expect(() =>
      analyzeSongFast('x', { sampleRate: SR, channels: [mono] }, { signal: controller.signal }),
    ).toThrow('Cancelled')
  })
})

describe('sectionFields', () => {
  it('cuts and relabels the sections at the detected chorus ranges', () => {
    const fields = sectionFields(
      {
        version: 1,
        sections: [
          { start: 0, end: 40, label: 'verse', group: 'A', energy: 0.4 },
          { start: 40, end: 60, label: 'chorus', group: 'B', energy: 0.8 },
        ],
        chorus: [{ start: 20.3, end: 29.8 }],
      },
      [0, 10, 20, 30, 40, 50],
    )
    expect(fields.map((s) => [s.start, s.end, s.label])).toEqual([
      [0, 20, 'verse'],
      [20, 30, 'chorus'],
      [30, 60, 'verse'],
    ])
  })
})
