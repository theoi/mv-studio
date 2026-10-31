import { describe, expect, it } from 'vitest'
import { checkSuitability } from '../../../../src/vision/segmentation/suitability.ts'
import { analyzeSubjects } from '../../../../src/vision/reframe/analyze.ts'
import { discMask, fakeSegmentation, fakeSource } from './fakes.ts'

describe('checkSuitability', () => {
  it('samples short shots 5 times a second and leaves flicker to the person track', async () => {
    // The subject changes size a lot between samples, which an earlier version mistook for flicker.
    const seg = fakeSegmentation((t, s) =>
      discMask(s, s.width / 2, s.height / 2, (s.height / 3) * (Math.round(t * 5) % 2 ? 1 : 0.7)),
    )
    const { source } = fakeSource({ duration: 4 })
    const report = await checkSuitability(seg, source)
    expect(report.sampledFrames).toBe(20)
    expect(report.stability).toBeNull()
    expect(report.verdict).toBe('good')
  })

  it('spreads samples over long shots and explains a wide shot', async () => {
    const seg = fakeSegmentation((_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 20))
    const { source } = fakeSource({ duration: 120 })
    const report = await checkSuitability(seg, source, { maxSamples: 60 })
    expect(report.sampledFrames).toBe(60)
    expect(report.stability).toBeNull()
    expect(report).toMatchObject({ verdict: 'unsuitable', reasons: ['subject-too-small'] })
  })

  it('counts only the mask the person detector sees as a person', async () => {
    // A large subject the segmenter cuts out but the detector does not call a person: an animal, say.
    const seg = fakeSegmentation(
      (_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 3),
      () => [],
    )
    const { source } = fakeSource({ duration: 2 })
    const report = await checkSuitability(seg, source)
    expect(report).toMatchObject({ verdict: 'unsuitable', reasons: ['no-subject'] })
  })

  it('looks for people on 512 px frames, makes masks at 256 px, and can skip frames for people', async () => {
    const seg = fakeSegmentation()
    const { source } = fakeSource({ duration: 2 })
    const report = await checkSuitability(seg, source, { peopleEvery: 2 })
    expect(report.verdict).toBe('good')
    expect(seg.analyzed).toHaveLength(10)
    expect(seg.analyzed.map((a) => !!a.people)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ])
    expect(seg.analyzed[0]!.size).toEqual({ width: 512, height: 288 })
    expect(seg.analyzed[0]!.maskSize).toEqual({ width: 256, height: 144 })
  })
})

describe('analyzeSubjects', () => {
  it('follows the detected face and records the person box', async () => {
    const seg = fakeSegmentation((_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 3))
    const { source } = fakeSource({ duration: 2 })
    const track = await analyzeSubjects(seg, source)
    expect(track.samples).toHaveLength(10)
    const s = track.samples[5]!
    expect(s.source).toBe('face')
    expect(s.focus.x).toBeCloseTo(0.5, 2)
    expect(s.focus.y).toBeCloseTo(0.375, 2)
    expect(s.box!.height).toBeGreaterThan(0.6)
  })
})
