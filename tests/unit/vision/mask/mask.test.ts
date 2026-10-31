import { describe, expect, it } from 'vitest'
import type { GrayImage, Mask, RgbaImage } from '../../../../src/vision/types.ts'
import {
  boundingBox,
  centroid,
  components,
  coverage,
  floatToMask,
  interiorPoints,
  iou,
  keepMajorComponents,
  resizeMask,
  shiftMask,
} from '../../../../src/vision/mask/ops.ts'
import { createCausalSmoother, createTemporalFilter } from '../../../../src/vision/mask/smoothing.ts'
import { jointBilateralUpsample } from '../../../../src/vision/mask/upsample.ts'
import {
  assessFrame,
  assessSuitability,
  keepPeople,
  peopleNear,
} from '../../../../src/vision/mask/suitability.ts'
import {
  appendFrame,
  createPackedTrack,
  createTrackReader,
  deserializeTrack,
  sampleAt,
  serializeTrack,
} from '../../../../src/vision/mask/track.ts'

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number, value = 255): Mask {
  const data = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = value
  return { width: w, height: h, data }
}

function gray(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y)
  return { width: w, height: h, data }
}

describe('mask ops', () => {
  it('floatToMask clamps and scales', () => {
    expect(Array.from(floatToMask(new Float32Array([-1, 0, 0.5, 1, 2]), 5, 1).data)).toEqual([
      0, 0, 128, 255, 255,
    ])
  })

  it('coverage, box, centroid and iou describe a rectangle', () => {
    const m = rectMask(100, 50, 10, 5, 30, 25)
    expect(coverage(m)).toBeCloseTo((20 * 20) / 5000)
    expect(boundingBox(m)).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.4 })
    const c = centroid(m)!
    expect(c.x).toBeCloseTo(0.2)
    expect(c.y).toBeCloseTo(0.3)
    expect(iou(m, shiftMask(m, 10, 0))).toBeCloseTo(10 / 30)
    expect(boundingBox(rectMask(10, 10, 0, 0, 0, 0))).toBeNull()
  })

  it('resize preserves the shape of a mask', () => {
    const m = rectMask(64, 64, 16, 16, 48, 48)
    const up = resizeMask(m, 256, 256)
    expect(coverage(up)).toBeCloseTo(0.25, 1)
    expect(iou(resizeMask(up, 64, 64), m)).toBeGreaterThan(0.95)
  })

  it('components are found and ranked by area; small specks can be removed', () => {
    const m = rectMask(50, 50, 0, 0, 20, 20)
    for (let y = 30; y < 33; y++) for (let x = 30; x < 33; x++) m.data[y * 50 + x] = 255
    for (let y = 40; y < 50; y++) for (let x = 40; x < 50; x++) m.data[y * 50 + x] = 255
    const { components: comps } = components(m)
    expect(comps.map((c) => c.area)).toEqual([400, 100, 9])
    const cleaned = keepMajorComponents(m, 0.1)
    expect(components(cleaned).components.map((c) => c.area)).toEqual([400, 100])
  })

  it('interior points lie deep inside the mask and are separated', () => {
    const m = rectMask(80, 40, 10, 10, 70, 30)
    const pts = interiorPoints(m, 3, 3)
    expect(pts.length).toBeGreaterThanOrEqual(2)
    for (const p of pts) {
      const x = p.x * 80
      const y = p.y * 40
      expect(x).toBeGreaterThan(12)
      expect(x).toBeLessThan(68)
      expect(y).toBeGreaterThan(12)
      expect(y).toBeLessThan(28)
    }
    expect(Math.hypot((pts[0]!.x - pts[1]!.x) * 80, (pts[0]!.y - pts[1]!.y) * 40)).toBeGreaterThan(5)
    expect(interiorPoints(rectMask(10, 10, 0, 0, 0, 0))).toEqual([])
  })
})

describe('temporal smoothing', () => {
  it('causal smoother damps flicker on a static image but follows real motion', () => {
    const still = gray(32, 32, () => 100)
    const s = createCausalSmoother()
    s.push(rectMask(32, 32, 8, 8, 24, 24), still)
    const flicker = s.push(rectMask(32, 32, 8, 8, 24, 24, 0), still)
    expect(flicker.data[16 * 32 + 16]).toBeGreaterThan(120)

    const s2 = createCausalSmoother()
    s2.push(rectMask(32, 32, 8, 8, 24, 24), still)
    const moved = gray(32, 32, () => 180)
    const follow = s2.push(rectMask(32, 32, 8, 8, 24, 24, 0), moved)
    expect(follow.data[16 * 32 + 16]).toBeLessThan(30)
  })

  it('temporal filter is zero-lag, removes a one-frame dropout, and emits every frame', () => {
    const g = gray(16, 16, () => 90)
    const f = createTemporalFilter({ radius: 2 })
    const masks = [255, 255, 0, 255, 255, 255].map((v) => rectMask(16, 16, 0, 0, 16, 16, v))
    const out: Mask[] = []
    for (const m of masks) {
      const r = f.push(m, g)
      if (r) out.push(r)
    }
    out.push(...f.flush())
    expect(out).toHaveLength(masks.length)
    expect(out[2]!.data[0]).toBeGreaterThan(150)
    expect(out[5]!.data[0]).toBe(255)
  })

  it('temporal filter keeps edges where the guide changed', () => {
    const before = gray(8, 8, () => 20)
    const after = gray(8, 8, () => 230)
    const f = createTemporalFilter({ radius: 1 })
    const seq: Array<[number, GrayImage]> = [
      [0, before],
      [0, before],
      [255, after],
      [255, after],
      [255, after],
    ]
    const out: Mask[] = []
    for (const [v, gg] of seq) {
      const r = f.push(rectMask(8, 8, 0, 0, 8, 8, v), gg)
      if (r) out.push(r)
    }
    out.push(...f.flush())
    expect(out[1]!.data[0]).toBeLessThan(10)
    expect(out[2]!.data[0]).toBeGreaterThan(245)
  })
})

describe('joint bilateral upsampling', () => {
  it('snaps the mask edge to the image edge better than bilinear', () => {
    const W = 128
    const H = 64
    const edge = 70
    const hi: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = x < edge ? 230 : 30
        hi.data.set([v, v, v, 255], (y * W + x) * 4)
      }
    const lw = 16
    const lh = 8
    const lo: RgbaImage = { width: lw, height: lh, data: new Uint8ClampedArray(lw * lh * 4) }
    const low: Mask = { width: lw, height: lh, data: new Uint8Array(lw * lh) }
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const cx = (x + 0.5) * (W / lw)
        const v = cx < edge ? 230 : 30
        lo.data.set([v, v, v, 255], (y * lw + x) * 4)
        low.data[y * lw + x] = cx < edge ? 255 : 0
      }
    const truth = rectMask(W, H, 0, 0, edge, H)
    const jbu = jointBilateralUpsample(low, lo, hi)
    const bil = resizeMask(low, W, H)
    const err = (m: Mask) => m.data.reduce((a, v, i) => a + Math.abs(v - truth.data[i]!), 0)
    expect(err(jbu)).toBeLessThan(err(bil) * 0.5)
  })
})

describe('suitability', () => {
  const W = 64
  const H = 36
  const big = rectMask(W, H, 20, 6, 40, 36)
  const tiny = rectMask(W, H, 30, 28, 33, 34)
  const empty = rectMask(W, H, 0, 0, 0, 0)
  const full = rectMask(W, H, 0, 0, W, H)

  it('classifies single frames', () => {
    expect(assessFrame(0, big).verdict).toBe('ok')
    expect(assessFrame(0, tiny).verdict).toBe('subject-too-small')
    expect(assessFrame(0, empty).verdict).toBe('no-subject')
    expect(assessFrame(0, full).verdict).toBe('subject-fills-frame')
    const crowd = rectMask(W, H, 0, 0, 0, 0)
    for (let k = 0; k < 6; k++)
      for (let y = 28; y < 33; y++) for (let x = 4 + k * 10; x < 7 + k * 10; x++) crowd.data[y * W + x] = 255
    expect(assessFrame(0, crowd).verdict).toBe('many-small-subjects')
  })

  it('gives good, marginal with ranges, and unsuitable verdicts', () => {
    const at = (masks: Mask[]) => masks.map((mask, i) => ({ t: i, mask }))
    expect(assessSuitability(at(Array(8).fill(big)), 1).verdict).toBe('good')
    const mixed = assessSuitability(at([tiny, tiny, tiny, big, big, big, tiny, tiny]), 1)
    expect(mixed.verdict).toBe('marginal')
    expect(mixed.reasons[0]).toBe('subject-too-small')
    expect(mixed.suitableRanges).toEqual([{ start: 2.5, end: 5.5 }])
    const wide = assessSuitability(at(Array(8).fill(tiny)), 1)
    expect(wide).toMatchObject({ verdict: 'unsuitable', reasons: ['subject-too-small'], suitableRanges: [] })
    expect(assessSuitability([], 1).verdict).toBe('unsuitable')
  })

  it('flags a mask that jumps back and forth for single frames as unstable', () => {
    const narrow = rectMask(W, H, 25, 6, 35, 36)
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i * 0.2,
      prev: narrow,
      mask: big,
      next: narrow,
    }))
    const r = assessSuitability(samples, 0.2)
    expect(r.stability!).toBeCloseTo(0.5, 2)
    expect(r.reasons).toContain('unstable-mask')
    expect(r.verdict).not.toBe('good')
  })

  it('does not count movement or a changing pose as flicker', () => {
    // Frame k: the subject has moved 2 px and grown 1 px; samples are 5 frames apart, each with its neighbours.
    const pose = (k: number) => rectMask(160, H, 4 + 2 * k, 6, 4 + 2 * k + 10 + k, H)
    const samples = Array.from({ length: 8 }, (_, i) => ({
      t: i * 0.2,
      prev: pose(5 * i - 1),
      mask: pose(5 * i),
      next: pose(5 * i + 1),
    }))
    const r = assessSuitability(samples, 0.2)
    expect(r.stability).toBe(1)
    expect(r.verdict).toBe('good')
  })

  it('does not judge stability from samples without their neighbouring frames', () => {
    const narrow = rectMask(W, H, 25, 6, 35, 36)
    const r = assessSuitability(
      Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: i % 2 ? big : narrow })),
      0.2,
    )
    expect(r.stability).toBeNull()
    expect(r.verdict).toBe('good')
  })
})

describe('person evidence for the verdict', () => {
  const W = 64
  const H = 36
  // A subject 30 px tall in the middle: the same mask whether it is a person or a horse.
  const subject = rectMask(W, H, 20, 6, 40, 36)
  const around = { x: 20 / W, y: 6 / H, width: 20 / W, height: 30 / H }

  it('keeps the mask inside the grown person boxes only', () => {
    const full = rectMask(W, H, 0, 0, W, H)
    const kept = keepPeople(full, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }], 0.1)
    // 0.2..0.8 of each side.
    expect(coverage(kept)).toBeCloseTo(
      ((Math.ceil(0.8 * W) - Math.floor(0.2 * W)) * (Math.ceil(0.8 * H) - Math.floor(0.2 * H))) / (W * H),
      5,
    )
    expect(kept.data[0]).toBe(0)
    expect(kept.data[(H / 2) * W + W / 2]).toBe(255)
  })

  it('bridges a missed detection between two hits, but does not spread a stray hit', () => {
    const other = { x: 0, y: 0, width: 0.1, height: 0.1 }
    const hits = new Map([
      [1, around],
      [3, around],
      [7, other],
    ])
    const people = Array.from({ length: 12 }, (_, i) => ({
      t: i * 0.2,
      boxes: hits.has(i) ? [hits.get(i)!] : [],
    }))
    // The clip's first frame needs a hit after it only.
    expect(peopleNear(people, 0)).toEqual([around])
    expect(peopleNear(people, 0.4)).toEqual([around, around])
    expect(peopleNear(people, 0.8)).toEqual([])
    expect(peopleNear(people, 1.2)).toEqual([])
    expect(peopleNear(people, 1.4)).toEqual([other])
    expect(peopleNear(people, 1.6)).toEqual([])
    // Within the hold of the last frame, a hit before it is enough.
    expect(peopleNear(people, 1.8)).toEqual([other])
  })

  it('does not let an animal the detector takes for a person now and then cover the shot', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.2, mask: subject }))
    const now = samples.map((s, i) => ({ t: s.t, boxes: i % 5 ? [] : [around] }))
    expect(assessSuitability(samples, 0.2, {}, now)).toMatchObject({
      verdict: 'unsuitable',
      reasons: ['no-subject'],
    })
  })

  it('finds no one in a mask the detector does not see as a person', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: subject }))
    expect(assessSuitability(samples, 0.2).verdict).toBe('good')
    const noOne = assessSuitability(
      samples,
      0.2,
      {},
      samples.map((s) => ({ t: s.t, boxes: [] })),
    )
    expect(noOne).toMatchObject({ verdict: 'unsuitable', reasons: ['no-subject'] })
  })

  it('keeps a person the detector sees in every other frame', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: subject }))
    const everyOther = samples.map((s, i) => ({ t: s.t, boxes: i % 2 ? [] : [around] }))
    expect(assessSuitability(samples, 0.2, {}, everyOther).verdict).toBe('good')
  })

  it('judges only the part of the mask that is a person', () => {
    // A person box around a small figure; the large blob beside it (an animal, say) does not count.
    const figure = rectMask(W, H, 4, 20, 8, 30)
    const both = { width: W, height: H, data: figure.data.map((v, i) => Math.max(v, subject.data[i]!)) }
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: both }))
    const people = samples.map((s) => ({
      t: s.t,
      boxes: [{ x: 4 / W, y: 20 / H, width: 4 / W, height: 10 / H }],
    }))
    expect(assessSuitability(samples, 0.2, {}, people)).toMatchObject({
      verdict: 'unsuitable',
      reasons: ['subject-too-small'],
    })
  })
})
describe('packed mask tracks', () => {
  const meta = {
    version: 1 as const,
    kind: 'person' as const,
    mediaId: 'm1',
    sourceSize: { width: 1920, height: 1080 },
    maskSize: { width: 32, height: 18 },
    fps: 10,
    start: 2,
    model: 'test',
    quality: 'standard' as const,
  }

  it('samples times to frame pairs with clamping', () => {
    const track = createPackedTrack(meta)
    for (let i = 0; i < 5; i++) appendFrame(track, rectMask(32, 18, 0, 0, 32, 18, i * 50), 0.5)
    expect(sampleAt(track.meta, 1)).toEqual({ i0: 0, i1: 0, weight: 0 })
    expect(sampleAt(track.meta, 2.25)).toMatchObject({ i0: 2, i1: 3 })
    expect(sampleAt(track.meta, 2.25).weight).toBeCloseTo(0.5)
    expect(sampleAt(track.meta, 9)).toEqual({ i0: 4, i1: 4, weight: 0 })
  })

  it('reader blends neighbouring frames and round-trips through serialization', async () => {
    const track = createPackedTrack(meta)
    for (let i = 0; i < 5; i++) appendFrame(track, rectMask(32, 18, 0, 0, 32, 18, i * 50), i / 4)
    const reader = createTrackReader(await deserializeTrack(await serializeTrack(track)))
    expect(reader.meta.frameCount).toBe(5)
    expect(reader.meta.coverage).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(reader.frame(3).data[0]).toBe(150)
    expect(reader.at(2.15).data[0]).toBe(75)
  })

  it('rejects frames of the wrong size', () => {
    const track = createPackedTrack(meta)
    expect(() => appendFrame(track, rectMask(10, 10, 0, 0, 1, 1), 0)).toThrow()
  })
})
