import { describe, expect, it } from 'vitest'
import { evaluate } from '../../../src/engine/animation.ts'
import {
  fitLoopRange,
  fitTeaserRange,
  loopLengthRange,
  loopLengths,
  loopRange,
  loopSeam,
  movedRange,
  newOutput,
  planOutput,
  sectionTeaserRange,
  teaserLengthPatch,
  teaserRange,
  TEASER_FADES,
} from '../../../src/export/index.ts'
import {
  createAudioClip,
  createProject,
  createSolidClip,
  type AudioClip,
  type SongSection,
} from '../../../src/model/index.ts'

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)?.[1]) * 0.5

/**
 * A song of `duration` seconds at `bpm` on the timeline from `offset`, with beats, bars and sections in song time,
 * and a solid filling the timeline.
 */
function song(
  o: { duration?: number; bpm?: number; offset?: number; sections?: Omit<SongSection, 'id'>[] } = {},
) {
  const duration = o.duration ?? 60
  const bpm = o.bpm ?? 120
  const offset = o.offset ?? 0
  const project = createProject({ name: 'Song' })
  project.songAssetId = 'song'
  const audioTrack = project.tracks.find((t) => t.kind === 'audio')!
  const clip = createAudioClip({ trackId: audioTrack.id, assetId: 'song', start: offset, duration })
  project.clips[clip.id] = clip
  const solid = createSolidClip({
    trackId: project.tracks[0]!.id,
    color: '#336699',
    start: 0,
    duration: offset + duration,
  })
  project.clips[solid.id] = solid
  const beat = 60 / bpm
  const beats = Array.from({ length: Math.floor(duration / beat) + 1 }, (_, i) => i * beat)
  project.analysis.audio.song = {
    assetId: 'song',
    version: 'test',
    tempo: { bpm, confidence: 1 },
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    ...(o.sections ? { sections: o.sections.map((s, i) => ({ ...s, id: `s${i}` })) } : {}),
  }
  return { project, clip }
}

const sections: Omit<SongSection, 'id'>[] = [
  { start: 0, end: 12, label: 'verse', repeatGroup: 1, energy: 0.3 },
  { start: 12, end: 28, label: 'chorus', repeatGroup: 2, energy: 0.7 },
  { start: 28, end: 40, label: 'verse', repeatGroup: 1, energy: 0.35 },
  { start: 40, end: 56, label: 'chorus', repeatGroup: 2, energy: 0.85 },
  { start: 56, end: 60, label: 'outro', repeatGroup: 3, energy: 0.2 },
]

describe('teaserRange', () => {
  it('starts on the loudest chorus, on a bar, and ends on a bar near the chorus end', () => {
    const { project } = song({ sections, offset: 1 })
    const pick = teaserRange(project)!
    // Song time 40 is timeline 41; the chorus ends at 57 (16 s, on a bar).
    expect(pick).toMatchObject({ start: 41, end: 57, source: 'chorus', label: 'chorus' })
    expect(pick.confidence).toBeGreaterThan(0.5)
  })

  it("reports the picked chorus's label confidence, 0.6 when the analysis gives none", () => {
    const sure = song({
      sections: sections.map((s) => (s.label === 'chorus' ? { ...s, confidence: 0.8 } : s)),
    })
    expect(teaserRange(sure.project)).toMatchObject({ start: 40, source: 'chorus', confidence: 0.8 })
    expect(teaserRange(song({ sections }).project)?.confidence).toBe(0.6)
    const repeated = song({ sections: sections.map((s) => ({ ...s, label: 'part', confidence: 0.9 })) })
    expect(teaserRange(repeated.project)).toMatchObject({ source: 'section', confidence: 0.4 })
  })

  it('extends a short chorus to 15 s and trims a long one to 30 s, on bars', () => {
    const short = song({
      sections: [
        { start: 0, end: 20, label: 'verse', repeatGroup: 1, energy: 0.3 },
        { start: 20, end: 26, label: 'chorus', repeatGroup: 2, energy: 0.8 },
        { start: 26, end: 40, label: 'verse', repeatGroup: 1, energy: 0.3 },
        { start: 40, end: 46, label: 'chorus', repeatGroup: 2, energy: 0.7 },
      ],
    })
    expect(teaserRange(short.project)).toMatchObject({ start: 20, end: 36 })
    const long = song({
      sections: [
        { start: 4, end: 50, label: 'chorus', repeatGroup: 2, energy: 0.8 },
        { start: 50, end: 60, label: 'chorus', repeatGroup: 2, energy: 0.5 },
      ],
    })
    expect(teaserRange(long.project)).toMatchObject({ start: 4, end: 34 })
  })

  it('skips a strongest chorus with no room before the end for a full teaser', () => {
    const { project } = song({
      duration: 40,
      sections: [
        { start: 0, end: 10, label: 'verse', repeatGroup: 1, energy: 0.3 },
        { start: 10, end: 20, label: 'chorus', repeatGroup: 2, energy: 0.8 },
        { start: 20, end: 28, label: 'verse', repeatGroup: 1, energy: 0.35 },
        { start: 28, end: 38, label: 'chorus', repeatGroup: 2, energy: 0.9 },
      ],
    })
    expect(teaserRange(project)).toMatchObject({ start: 10, end: 26, source: 'chorus' })
  })

  it('falls back to the loudest part, then to the start, and uses all of a short timeline', () => {
    const { project } = song()
    const analysis = project.analysis.audio.song!
    analysis.energy = { rate: 1, values: Array.from({ length: 60 }, (_, i) => (i >= 30 && i < 50 ? 1 : 0.2)) }
    expect(teaserRange(project)).toMatchObject({ start: 30, end: 50, source: 'energy' })
    delete analysis.energy
    expect(teaserRange(project)).toMatchObject({ start: 0, end: 20, source: 'start' })
    expect(teaserRange(song({ duration: 12 }).project)).toMatchObject({ start: 0, end: 12 })
  })
})

describe('fitTeaserRange and sectionTeaserRange', () => {
  it('moves a dragged range onto bars and keeps it 15 to 30 s long inside the timeline', () => {
    const { project } = song({ sections })
    expect(fitTeaserRange(project, { start: 12.7, end: 29.1 })).toEqual({ start: 12, end: 28 })
    expect(fitTeaserRange(project, { start: 3.1, end: 8 })).toEqual({ start: 4, end: 20 })
    expect(fitTeaserRange(project, { start: 0, end: 50 })).toEqual({ start: 0, end: 30 })
    expect(fitTeaserRange(project, { start: 55, end: 60 })).toEqual({ start: 44, end: 60 })
  })

  it('starts a teaser on a chosen section, in timeline time', () => {
    const { project } = song({ sections, offset: 1 })
    expect(sectionTeaserRange(project, 's1')).toEqual({ start: 13, end: 29 })
    expect(sectionTeaserRange(project, 'missing')).toBeNull()
  })
})

describe('loopRange', () => {
  it('takes four bars from the teaser start when they last at most 8 s, else two', () => {
    expect(loopRange(song({ sections }).project)).toMatchObject({
      start: 40,
      end: 48,
      bars: 4,
      crossfade: 0.5,
    })
    // At 100 BPM a bar is 2.4 s, so four bars (9.6 s) are too long.
    const slow = loopRange(song({ sections, bpm: 100 }).project)!
    expect(slow.bars).toBe(2)
    expect(slow.end - slow.start).toBeCloseTo(4.8)
  })

  it('starts late enough for the crossfade to have frames before it', () => {
    expect(loopRange(song().project, undefined, 0)).toMatchObject({ start: 2, end: 10, bars: 4 })
  })

  it('offers loop lengths in seconds, not guessed bars, while the bars are not found', () => {
    const { project } = song({ sections })
    delete project.analysis.audio.song!.downbeats
    expect(loopLengths(project, 12)).toEqual([4, 6, 8].map((seconds) => ({ bars: 0, seconds })))
  })

  it('fits a chosen number of bars from the nearest bar, inside the timeline and after the crossfade room', () => {
    const { project } = song({ sections })
    expect(fitLoopRange(project, 21.2, 2)).toEqual({ start: 22, end: 26, bars: 2, crossfade: 0.5 })
    expect(fitLoopRange(project, 0, 1)).toEqual({ start: 2, end: 4, bars: 1, crossfade: 0.5 })
    expect(fitLoopRange(project, 59, 4)).toEqual({ start: 52, end: 60, bars: 4, crossfade: 0.5 })
    expect(fitLoopRange(song({ duration: 6 }).project, 0, 4)).toBeNull()
  })
})

describe('planOutput: teaser and loop', () => {
  it('renders the teaser range with a fade from and to black and the song fading at its edges', () => {
    const { project, clip } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'teaser'), { measure })
    expect(planned.spec).toMatchObject({ aspect: '9:16', name: 'Song - Teaser' })
    expect(planned.range).toEqual({ start: 40, end: 56 })
    expect(planned.settings.range).toEqual({ start: 40, end: 56 })
    expect(planned.duration).toBe(16)
    expect(planned.teaser).toMatchObject({ source: 'chorus' })

    const p = planned.project
    const top = p.tracks[0]!
    const fades = Object.values(p.clips).filter((c) => c.trackId === top.id)
    const opacityAt = (t: number) =>
      fades
        .filter((c) => t >= c.start && t < c.start + c.duration)
        .map((c) => (c.type === 'solid' ? evaluate(c.opacity, t - c.start) : 0))[0] ?? 0
    expect(opacityAt(40)).toBeCloseTo(1)
    expect(opacityAt(40 + TEASER_FADES.videoIn / 2)).toBeCloseTo(0.5)
    expect(opacityAt(48)).toBe(0)
    expect(opacityAt(56 - 1e-3)).toBeCloseTo(1, 2)

    const audio = Object.values(p.clips).filter((c): c is AudioClip => c.type === 'audio')
    const inRange = audio.find((c) => Math.abs(c.start - 40) < 1e-6)!
    expect(inRange).toMatchObject({ duration: 16, sourceStart: 40 })
    expect(inRange.fadeIn).toBe(TEASER_FADES.audioIn)
    expect(inRange.fadeOut).toBe(TEASER_FADES.audioOut)
    // The source project is untouched.
    expect(project.clips[clip.id]).toMatchObject({ start: 0, duration: 60, fadeIn: 0, fadeOut: 0 })
  })

  it('uses a range picked on the mini song lane, on bars, instead of the automatic one', () => {
    const { project } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'teaser', { range: { start: 12.3, end: 30.2 } }), {
      measure,
    })
    expect(planned.range).toEqual({ start: 12, end: 30 })
    expect(planned.settings.range).toEqual({ start: 12, end: 30 })
  })

  it('blends the frames before a loop into its end, so its last frame leads into its first', () => {
    const { project } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'loop'), { measure })
    expect(planned.loop).toMatchObject({ start: 40, end: 48, bars: 4, crossfade: 0.5, barAligned: true })
    expect(planned.exportOptions.audio).toBe('none')
    const at = planned.exportOptions.frameTimes!
    expect(at(0)).toEqual([{ time: 40, weight: 1 }])
    expect(at(4)).toEqual([{ time: 44, weight: 1 }])
    const last = at(8 - 1 / 30)
    expect(last).toHaveLength(2)
    expect(last[1]!.time).toBeCloseTo(40 - 1 / 30)
    expect(last[1]!.weight).toBeGreaterThan(0.95)
    expect(last[0]!.weight + last[1]!.weight).toBeCloseTo(1)
    const middle = at(8 - 0.25)
    expect(middle[1]!.weight).toBeCloseTo(0.5)
    expect(planned.estimatedBytes).toBeLessThan(
      planOutput(project, newOutput(project, 'loop', { audio: true }), { measure }).estimatedBytes,
    )
    expect(
      typeof planOutput(project, newOutput(project, 'loop', { audio: true }), { measure }).exportOptions
        .audio,
    ).toBe('function')
  })

  it('flags a hand-picked loop that does not start and end on bars', () => {
    const { project } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'loop', { range: { start: 41, end: 47 } }), {
      measure,
    })
    expect(planned.loop).toMatchObject({ barAligned: false, crossfade: 0.5 })
  })
})

describe('teaser length and moving a range on the song lane', () => {
  it('runs a 15 or 30 s teaser as close to its length as the bars allow, from the strongest chorus', () => {
    const { project } = song({ sections, duration: 90 })
    const plan = (maxLength?: number) =>
      planOutput(project, newOutput(project, 'teaser', { maxLength }), { measure })
    expect(plan(15).range).toEqual({ start: 40, end: 54 })
    expect(plan(30).range).toEqual({ start: 40, end: 70 })
    expect(plan().range).toEqual({ start: 40, end: 56 })
  })

  it('moves a teaser to a dragged start on a bar, keeping its length', () => {
    const { project } = song({ sections, duration: 90 })
    const planned = planOutput(project, newOutput(project, 'teaser', { maxLength: 15 }), { measure })
    expect(movedRange(project, planned, 21.3)).toEqual({ start: 22, end: 36 })
    expect(
      movedRange(project, planOutput(project, newOutput(project, 'video'), { measure }), 21.3),
    ).toBeNull()
  })

  it('keeps a placed teaser start when its length changes, and picks an automatic one again', () => {
    const { project } = song({ sections, duration: 90 })
    const placed = planOutput(project, newOutput(project, 'teaser', { range: { start: 22, end: 38 } }), {
      measure,
    })
    expect(teaserLengthPatch(project, placed, 30)).toEqual({ maxLength: 30, range: { start: 22, end: 52 } })
    const auto = planOutput(project, newOutput(project, 'teaser'), { measure })
    expect(teaserLengthPatch(project, auto, 30)).toEqual({ maxLength: 30 })
  })

  it('makes a placed teaser as long as the section it starts on again for "Whole section"', () => {
    const { project } = song({
      duration: 90,
      sections: [
        { start: 0, end: 28, label: 'verse', repeatGroup: 1, energy: 0.3 },
        { start: 28, end: 44, label: 'chorus', repeatGroup: 2, energy: 0.8 },
        { start: 44, end: 90, label: 'outro', repeatGroup: 3, energy: 0.2 },
      ],
    })
    const short = planOutput(
      project,
      newOutput(project, 'teaser', { maxLength: 15, range: { start: 0, end: 14 } }),
      { measure },
    )
    expect(teaserLengthPatch(project, short, null)).toEqual({
      maxLength: undefined,
      range: { start: 0, end: 28 },
    })
  })
})

describe('loop length and seam', () => {
  it('offers the bar counts that last 3 to 8 s at the loop start, or seconds without a beat grid', () => {
    expect(loopLengths(song({ sections }).project, 40)).toEqual([
      { bars: 2, seconds: 4 },
      { bars: 4, seconds: 8 },
    ])
    // At 90 BPM a bar is 2.67 s: one bar is too short and four are too long.
    expect(loopLengths(song({ sections, bpm: 90 }).project, 40).map((l) => l.bars)).toEqual([2])
    const { project } = song()
    delete project.analysis.audio.song
    expect(loopLengths(project, 40)).toEqual([
      { bars: 0, seconds: 4 },
      { bars: 0, seconds: 6 },
      { bars: 0, seconds: 8 },
    ])
  })

  it('changes a loop length from its start and moves it bar by bar', () => {
    const { project } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'loop'), { measure })
    expect(planned.range).toEqual({ start: 40, end: 48 })
    expect(loopLengthRange(project, planned, { bars: 2, seconds: 4 })).toEqual({ start: 40, end: 44 })
    expect(movedRange(project, planned, 23.1)).toEqual({ start: 24, end: 32 })
  })

  it('moves a loop without a beat grid by seconds, keeping its length', () => {
    const { project } = song()
    delete project.analysis.audio.song
    const planned = planOutput(project, newOutput(project, 'loop'), { measure })
    expect(planned.duration).toBeCloseTo(6)
    expect(movedRange(project, planned, 30.25)).toEqual({ start: 30.25, end: 36.25 })
  })

  it('shows the frame before the loop start as its last frame when it crossfades', () => {
    const { project } = song({ sections })
    const planned = planOutput(project, newOutput(project, 'loop'), { measure })
    expect(loopSeam(planned)).toEqual({ last: 39.967, first: 40 })
    expect(loopSeam(planOutput(project, newOutput(project, 'teaser'), { measure }))).toBeNull()
  })
})
