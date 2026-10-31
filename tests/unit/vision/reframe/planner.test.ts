import { describe, it, expect } from 'vitest'
import type { ReframePlan, SubjectSample, SubjectTrack } from '../../../../src/vision/types.ts'
import { baseCropSize, cropAt, planReframe } from '../../../../src/vision/reframe/planner.ts'

const LANDSCAPE = { width: 1920, height: 1080 }
const PORTRAIT = { width: 1080, height: 1920 }
const FPS = 30

function point(t: number, x: number, y: number): SubjectSample {
  return { t, focus: { x, y }, box: null, confidence: 1, source: 'face' }
}

function track(samples: SubjectSample[], sourceSize = LANDSCAPE): SubjectTrack {
  return { version: 1, mediaId: 'clip', sourceSize, samples }
}

function timeline(seconds: number, f: (t: number, i: number) => { x: number; y: number }): SubjectSample[] {
  return Array.from({ length: Math.round(seconds * FPS) + 1 }, (_, i) => {
    const t = i / FPS
    const p = f(t, i)
    return point(t, p.x, p.y)
  })
}

function expectInside(plan: ReframePlan, t: number) {
  const r = cropAt(plan, t)
  expect(r.x).toBeGreaterThanOrEqual(-1e-12)
  expect(r.y).toBeGreaterThanOrEqual(-1e-12)
  expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-12)
  expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-12)
}

describe('baseCropSize', () => {
  it('fits the largest crop of the target aspect', () => {
    expect(baseCropSize(LANDSCAPE, '9:16')).toEqual({ width: 0.31640625, height: 1 })
    expect(baseCropSize(PORTRAIT, '16:9')).toEqual({ width: 1, height: 0.31640625 })
    const square = baseCropSize(LANDSCAPE, '1:1')
    expect(square.width).toBeCloseTo(0.5625)
    expect(square.height).toBe(1)
    const fourFive = baseCropSize(LANDSCAPE, '4:5')
    expect(fourFive.width).toBeCloseTo(0.8 * 0.5625)
    expect(fourFive.height).toBe(1)
    expect(baseCropSize(LANDSCAPE, '16:9')).toEqual({ width: 1, height: 1 })
    expect(baseCropSize({ width: 1000, height: 1000 }, '1:1')).toEqual({ width: 1, height: 1 })
  })
})

describe('planReframe', () => {
  it('frames a static subject with at most two keyframes centred on it', () => {
    const plan = planReframe(track(timeline(5, () => ({ x: 0.3, y: 0.4 }))), '9:16')
    expect(plan.keyframes.length).toBeGreaterThanOrEqual(1)
    expect(plan.keyframes.length).toBeLessThanOrEqual(2)
    for (const k of plan.keyframes) {
      expect(k.cx).toBeCloseTo(0.3)
      expect(k.cy).toBe(0.5)
      expect(k.zoom).toBe(1)
    }
    expect(plan.baseCrop.width).toBeCloseTo(0.31640625)
  })

  it('follows a subject moving slower than the speed limit and keeps it in frame', () => {
    // 0.15 / s is about 0.47 crop widths per second, below the 0.6 default
    const samples = timeline(4, (t) => ({ x: 0.2 + 0.15 * t, y: 0.5 }))
    const plan = planReframe(track(samples), '9:16')
    expect(plan.keyframes.length).toBeGreaterThan(2)
    for (const s of samples) {
      const r = cropAt(plan, s.t)
      expect(s.focus.x).toBeGreaterThan(r.x)
      expect(s.focus.x).toBeLessThan(r.x + r.width)
    }
    expect(cropAt(plan, 4).x + cropAt(plan, 4).width / 2).toBeGreaterThan(0.7)
  })

  it('never moves faster than maxSpeed when the subject jumps without a cut', () => {
    const maxSpeed = 0.6
    const samples = timeline(4, (t) => ({ x: t < 1 ? 0.2 : 0.8, y: 0.5 }))
    const plan = planReframe(track(samples), '9:16', { maxSpeed })
    const limit = maxSpeed * plan.baseCrop.width
    let moved = 0
    for (let i = 1; i < plan.keyframes.length; i++) {
      const a = plan.keyframes[i - 1]!
      const b = plan.keyframes[i]!
      expect(Math.abs(b.cx - a.cx) / (b.t - a.t)).toBeLessThanOrEqual(limit + 1e-6)
      moved += Math.abs(b.cx - a.cx)
    }
    expect(moved).toBeGreaterThan(0.3)
    expect(cropAt(plan, 1.2).x + cropAt(plan, 1.2).width / 2).toBeLessThan(0.5)
  })

  it('ignores small jitter inside the dead zone', () => {
    const plan = planReframe(
      track(timeline(3, (_, i) => ({ x: 0.5 + (i % 2 ? 0.005 : -0.005), y: 0.5 }))),
      '9:16',
    )
    const first = plan.keyframes[0]!
    expect(plan.keyframes.length).toBeLessThanOrEqual(2)
    for (const k of plan.keyframes) expect(k.cx).toBe(first.cx)
  })

  it('keeps the crop inside the source for a subject at the extreme edge', () => {
    const samples = timeline(2, (t) => ({ x: 0.999 - 0.001 * t, y: 0.001 }))
    for (const zoom of [1, 1.5]) {
      const plan = planReframe(track(samples), '9:16', { zoom })
      for (const s of samples) expectInside(plan, s.t)
      const w = plan.baseCrop.width / zoom
      const h = plan.baseCrop.height / zoom
      expect(plan.keyframes[0]!.cx).toBeCloseTo(1 - w / 2)
      expect(plan.keyframes[0]!.cy).toBeCloseTo(zoom === 1 ? 0.5 : h / 2)
    }
  })

  it('shifts the camera to keep the subject box in the crop', () => {
    const s: SubjectSample = {
      t: 0,
      focus: { x: 0.5, y: 0.5 },
      box: { x: 0.45, y: 0.2, width: 0.25, height: 0.6 },
      confidence: 1,
      source: 'face',
    }
    const w = baseCropSize(LANDSCAPE, '9:16').width
    const withBox = planReframe(track([s, { ...s, t: 1 }]), '9:16')
    expect(withBox.keyframes[0]!.cx).toBeCloseTo(0.7 - w / 2)
    const focusOnly = planReframe(track([s, { ...s, t: 1 }]), '9:16', { keepBox: false })
    expect(focusOnly.keyframes[0]!.cx).toBeCloseTo(0.5)
  })

  it('jumps instantly at a cut and keeps keyframes on both sides of it', () => {
    const samples = timeline(4, (t) => ({ x: t < 2 ? 0.2 : 0.8, y: 0.5 }))
    const plan = planReframe(track(samples), '9:16', { cuts: [2] })
    const before = plan.keyframes.find((k) => Math.abs(k.t - (2 - 1 / FPS)) < 1e-9)
    const after = plan.keyframes.find((k) => Math.abs(k.t - 2) < 1e-9)
    expect(before?.cx).toBeCloseTo(0.2)
    expect(after?.cx).toBeCloseTo(0.8)
    expect(cropAt(plan, 3).x + cropAt(plan, 3).width / 2).toBeCloseTo(0.8)
  })

  it('moves only vertically when reframing a vertical source to 16:9', () => {
    const samples = timeline(4, (t) => ({ x: 0.2 + 0.1 * t, y: 0.2 + 0.15 * t }))
    const plan = planReframe(track(samples, PORTRAIT), '16:9')
    expect(plan.baseCrop).toEqual({ width: 1, height: 0.31640625 })
    for (const k of plan.keyframes) expect(k.cx).toBe(0.5)
    const cys = plan.keyframes.map((k) => k.cy)
    expect(Math.max(...cys) - Math.min(...cys)).toBeGreaterThan(0.3)
  })
})

describe('cropAt', () => {
  const plan: ReframePlan = {
    version: 1,
    mediaId: 'clip',
    aspect: '9:16',
    sourceSize: LANDSCAPE,
    baseCrop: { width: 0.25, height: 1 },
    keyframes: [
      { t: 1, cx: 0.3, cy: 0.5, zoom: 1 },
      { t: 3, cx: 0.7, cy: 0.5, zoom: 2 },
      { t: 4, cx: 0.0, cy: 0.5, zoom: 2 },
    ],
  }

  it('interpolates centre and zoom linearly between keyframes', () => {
    const r = cropAt(plan, 2)
    expect(r.width).toBeCloseTo(0.25 / 1.5)
    expect(r.height).toBeCloseTo(1 / 1.5)
    expect(r.x + r.width / 2).toBeCloseTo(0.5)
    expect(r.y + r.height / 2).toBeCloseTo(0.5)
  })

  it('holds the end keyframes outside the keyframe range', () => {
    const start = cropAt(plan, -5)
    expect(start.x + start.width / 2).toBeCloseTo(0.3)
    expect(start.width).toBeCloseTo(0.25)
    const end = cropAt(plan, 99)
    expect(end.width).toBeCloseTo(0.125)
    expect(end.height).toBeCloseTo(0.5)
  })

  it('clamps a centre outside the valid range so the crop stays inside the source', () => {
    const end = cropAt(plan, 4)
    expect(end.x).toBe(0)
    expect(end.y).toBeCloseTo(0.25)
  })
})
