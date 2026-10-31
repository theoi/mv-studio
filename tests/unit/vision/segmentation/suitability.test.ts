import { describe, expect, it } from 'vitest'
import { checkSuitability } from '../../../../src/vision/segmentation/suitability.ts'
import { analyzeSubjects } from '../../../../src/vision/reframe/analyze.ts'
import { discMask, fakeSegmentation, fakeSource } from './fakes.ts'

describe('checkSuitability', () => {
  it('samples short shots densely enough to measure stability', async () => {
    const seg = fakeSegmentation((_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 3))
    const { source } = fakeSource({ duration: 4 })
    const report = await checkSuitability(seg, source)
    expect(report.sampledFrames).toBe(20)
    expect(report.stability).toBeCloseTo(1, 5)
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
