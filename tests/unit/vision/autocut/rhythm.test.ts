import { describe, expect, it } from 'vitest'
import { songInfoFromProject } from '../../../../src/director/inputs.ts'
import { beatsPerShot, cutSpans, type RhythmOptions } from '../../../../src/vision/autocut/rhythm.ts'
import { BEAT, BEATS, DOWNBEATS, makeProject, SECTIONS, SONG_LENGTH } from './fixtures.ts'

const song = songInfoFromProject(makeProject())
const whole = { start: 0, end: SONG_LENGTH }
const options = (o: Partial<RhythmOptions> = {}): RhythmOptions => ({
  pace: 'bar',
  followEnergy: true,
  cutOn: 'beats',
  range: whole,
  ...o,
})
const onGrid = (t: number, grid: number[]) => grid.some((b) => Math.abs(b - t) < 1e-6)
const lengthsIn = (spans: { start: number; end: number; sectionId: string }[], id: string) => [
  ...new Set(spans.filter((s) => s.sectionId === id).map((s) => Math.round((s.end - s.start) / BEAT))),
]

describe('auto-cut rhythm', () => {
  it('cuts verses every bar by default, choruses faster, intros and outros slower, and leads into faster parts', () => {
    const { spans } = cutSpans(song, options())
    expect(spans.every((s) => onGrid(s.start, BEATS))).toBe(true)
    const lastBar = (id: string) => SECTIONS.find((s) => s.id === id)!.end - 4 * BEAT - 1e-6
    const before = (id: string) => spans.filter((s) => s.sectionId === id && s.start < lastBar(id))
    expect(lengthsIn(before('verse'), 'verse')).toEqual([4])
    expect(lengthsIn(spans, 'chorus')).toEqual([2])
    expect(Math.round((before('intro')[0]!.end - before('intro')[0]!.start) / BEAT)).toBe(8)
    expect(lengthsIn(spans, 'outro')).toEqual([8])
    // The last bar before a faster section cuts at that section's pace.
    expect(
      lengthsIn(
        spans.filter((s) => s.start >= lastBar('verse') && s.sectionId === 'verse'),
        'verse',
      ),
    ).toEqual([2])
    expect(
      lengthsIn(
        spans.filter((s) => s.start >= lastBar('intro') && s.sectionId === 'intro'),
        'intro',
      ),
    ).toEqual([4])
    spans.slice(1).forEach((s, i) => expect(s.start).toBeCloseTo(spans[i]!.end, 9))
    expect(spans[0]!.start).toBe(0)
    expect(spans[spans.length - 1]!.end).toBe(SONG_LENGTH)
  })

  it('keeps one pace when not following the energy, and never cuts faster than a beat', () => {
    const steady = cutSpans(song, options({ followEnergy: false }))
    expect(new Set(steady.spans.map((s) => Math.round((s.end - s.start) / BEAT)))).toEqual(new Set([4]))
    const chorus = { label: 'Chorus', energy: 1 }
    const grid = (beatLength: number) => ({ beatLength, bpm: 60 / beatLength })
    expect(beatsPerShot('beat', chorus, { followEnergy: true, cutOn: 'beats', grid: grid(BEAT) })).toBe(1)
    expect(beatsPerShot('beat', chorus, { followEnergy: true, cutOn: 'beats', grid: grid(0.2) })).toBe(2)
  })

  it('paces by the section role before its energy', () => {
    const at = (section: { label: string; energy: number }) =>
      beatsPerShot('bar', section, {
        followEnergy: true,
        cutOn: 'beats',
        grid: { beatLength: BEAT, bpm: 100 },
      })
    // Energy normalized within a song often puts verses and choruses alike; the role still sets them apart.
    expect(at({ label: 'chorus', energy: 0.8 })).toBeLessThan(at({ label: 'verse', energy: 0.9 }))
    expect(at({ label: 'verse', energy: 0.9 })).toBeLessThan(at({ label: 'bridge', energy: 0.5 }))
    expect(at({ label: 'chorus', energy: 0.2 })).toBe(at({ label: 'verse', energy: 0.5 }))
    expect(at({ label: 'Part 2', energy: 0.9 })).toBeLessThan(at({ label: 'Part 1', energy: 0.2 }))
  })

  it('cuts only on bar starts or only at section boundaries when asked', () => {
    const bars = cutSpans(song, options({ cutOn: 'downbeats', pace: 'beat' }))
    expect(bars.spans.every((s) => onGrid(s.start, DOWNBEATS))).toBe(true)
    expect(lengthsIn(bars.spans, 'chorus')).toEqual([4])
    const sections = cutSpans(song, options({ cutOn: 'sections' }))
    expect(sections.spans.map((s) => s.start)).toEqual(SECTIONS.map((s) => s.start))
  })

  it('cuts on beats, not once per section, when asked for bar starts and the bars are not found', () => {
    const project = makeProject()
    delete project.analysis.audio.song!.downbeats
    const noBars = songInfoFromProject(project)
    const spans = cutSpans(noBars, options({ cutOn: 'downbeats', pace: 'beat' })).spans
    expect(spans.length).toBeGreaterThan(SECTIONS.length)
    expect(spans.every((s) => onGrid(s.start, BEATS))).toBe(true)
    expect(lengthsIn(spans, 'chorus')).toEqual([4])
  })

  it('splits shots longer than the footage on bar lines', () => {
    const { spans } = cutSpans(song, options({ cutOn: 'sections', maxShot: 6 }))
    expect(spans.every((s) => s.end - s.start <= 6 + 1e-6)).toBe(true)
    expect(spans.every((s) => onGrid(s.start, DOWNBEATS))).toBe(true)
  })

  it('stays inside the range and leaves the ranges to avoid uncut', () => {
    const { spans } = cutSpans(
      song,
      options({ range: { start: 12, end: 36 }, avoid: [{ start: 20, end: 25.1 }] }),
    )
    expect(spans[0]!.start).toBe(12)
    expect(spans[spans.length - 1]!.end).toBe(36)
    expect(spans.some((s) => s.start < 25.1 && s.end > 20)).toBe(false)
    expect(spans.find((s) => s.start >= 25.1)?.start).toBe(25.1)
    // A sliver shorter than a shot after an avoided range is left empty rather than flashing by.
    const sliver = cutSpans(song, options({ avoid: [{ start: 20, end: 26.2 }] }))
    expect(sliver.spans.find((s) => s.start >= 26.2)?.start).toBeCloseTo(26.4, 9)
  })
})
