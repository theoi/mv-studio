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
  detectedPeople,
  keepPeople,
  peopleNear,
  PERSON_MIN_SCORE,
  POP_MIN_SHARE,
  suitabilityInRange,
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

  /** Pop shares of consecutive frames at 25 fps from t = 0. */
  const series = (shares: number[]) => ({ start: 0, fps: 25, shares })

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

  it('measures stability as the share of frames without a visible pop, and flags a cutout that pops often', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.2, mask: big }))
    // 40 frames; every 5th pops by 8 % of the subject, the rest by a little.
    const often = Array.from({ length: 40 }, (_, i) => (i % 5 ? 0.01 : 0.08))
    const r = assessSuitability(samples, 0.2, {}, undefined, series(often))
    expect(r.stability).toBeCloseTo(0.8, 6)
    expect(r).toMatchObject({ verdict: 'marginal', reasons: ['unstable-mask'] })
    const calm = assessSuitability(
      samples,
      0.2,
      {},
      undefined,
      series(often.map(() => POP_MIN_SHARE - 0.001)),
    )
    expect(calm).toMatchObject({ verdict: 'good', stability: 1 })
  })

  it('names flicker first when it alone keeps a shot from good, after the frame reasons otherwise', () => {
    const popping = series(Array.from({ length: 50 }, (_, i) => (i % 4 ? 0 : 0.2)))
    const at = (masks: Mask[]) => masks.map((mask, i) => ({ t: i * 0.2, mask }))
    // 9 of 10 frames usable: good without the flicker.
    const mostly = assessSuitability(at([...Array(9).fill(big), tiny]), 0.2, {}, undefined, popping)
    expect(mostly).toMatchObject({ verdict: 'marginal', reasons: ['unstable-mask', 'subject-too-small'] })
    // About half the frames usable: marginal anyway, because of the small subject.
    const half = assessSuitability(
      at([...Array(8).fill(big), ...Array(7).fill(tiny)]),
      0.2,
      {},
      undefined,
      popping,
    )
    expect(half).toMatchObject({ verdict: 'marginal', reasons: ['subject-too-small', 'unstable-mask'] })
  })

  it('judges a part of the shot on its own frames and pops, from the report’s evidence', () => {
    // 6 s at 5 judged frames a second: a large person for the first 3 s, then a small one; pops only in the first second.
    const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.2, mask: i < 15 ? big : tiny }))
    const pops = series(Array.from({ length: 150 }, (_, i) => (i < 25 && i % 3 === 0 ? 0.2 : 0)))
    const whole = assessSuitability(samples, 0.2, {}, undefined, pops)
    expect(whole).toMatchObject({ verdict: 'marginal', reasons: ['subject-too-small'] })
    const evidence = whole.evidence!
    expect(suitabilityInRange(evidence, { start: 1, end: 3 })).toMatchObject({
      verdict: 'good',
      stability: 1,
      sampledFrames: 11,
    })
    expect(suitabilityInRange(evidence, { start: 3.2, end: 6 })).toMatchObject({
      verdict: 'unsuitable',
      reasons: ['subject-too-small'],
    })
    // The first second pops in 9 of its 25 frames.
    expect(suitabilityInRange(evidence, { start: 0, end: 1 })).toMatchObject({
      verdict: 'marginal',
      reasons: ['unstable-mask'],
      stability: 16 / 25,
    })
    // A part shorter than the spacing is judged on the frame nearest its middle.
    expect(suitabilityInRange(evidence, { start: 2.05, end: 2.15 })).toMatchObject({
      verdict: 'good',
      sampledFrames: 1,
    })
    // The whole range gives the whole verdict.
    expect(suitabilityInRange(evidence, { start: 0, end: 6 })).toEqual(whole)
  })

  it('judges a part of the shot with the shortest suitable range the report was judged with', () => {
    // 6 s at 5 judged frames a second, with a large person for 1 s (5 frames) from 2 s.
    const samples = Array.from({ length: 30 }, (_, i) => ({
      t: i * 0.2,
      mask: i >= 10 && i < 15 ? big : tiny,
    }))
    const part = { start: 1, end: 4 }
    expect(suitabilityInRange(assessSuitability(samples, 0.2).evidence!, part)).toMatchObject({
      verdict: 'marginal',
      suitableRanges: [{ start: expect.closeTo(1.9, 6), end: expect.closeTo(2.9, 6) }],
    })
    const strict = assessSuitability(samples, 0.2, { minRangeSeconds: 1.2 }).evidence!
    expect(suitabilityInRange(strict, part)).toMatchObject({ verdict: 'unsuitable', suitableRanges: [] })
    expect(suitabilityInRange(strict, part, { minRangeSeconds: 1 }).verdict).toBe('marginal')
  })

  it('leaves stability to the person track, which measures pops on every frame', () => {
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

  it.each([
    ['the track at 24 fps', 5 / 24],
    ['the track at 30 fps', 6 / 30],
    ['the track at 60 fps', 12 / 60],
    ['the quick check of a 60 s shot', 60 / 90],
  ])('bridges two missed detections in a row but not three, for %s', (_, interval) => {
    const at = (hits: number[]) =>
      Array.from({ length: 12 }, (_, i) => ({ t: i * interval, boxes: hits.includes(i) ? [around] : [] }))
    const two = at([0, 3])
    expect(peopleNear(two, interval)).toEqual([around, around])
    expect(peopleNear(two, 2 * interval)).toEqual([around, around])
    const three = at([0, 4])
    expect(peopleNear(three, interval)).toEqual([])
    expect(peopleNear(three, 2 * interval)).toEqual([around, around])
    expect(peopleNear(three, 3 * interval)).toEqual([])
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

  it('counts boxes from the minimum score, and can judge again at another limit from the stored scores', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: subject }))
    const unsure = samples.map((s) => ({ t: s.t, boxes: [around], scores: [0.25] }))
    expect(assessSuitability(samples, 0.2, {}, unsure)).toMatchObject({
      verdict: 'unsuitable',
      reasons: ['no-subject'],
    })
    expect(assessSuitability(samples, 0.2, { minPersonScore: 0.2 }, unsure).verdict).toBe('good')
    // Boxes stored without scores all passed the detector's former 0.3 floor.
    const older = unsure.map(({ t, boxes }) => ({ t, boxes }))
    expect(assessSuitability(samples, 0.2, {}, older).verdict).toBe('good')
  })

  it('stores a box scored just under the limit below it, so it still does not count', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.2, mask: subject }))
    for (const score of [0.2995, 0.2999]) {
      const found = samples.map((s) => detectedPeople(s.t, [{ box: around, score }]))
      expect(found[0]!.scores![0]).toBeLessThan(PERSON_MIN_SCORE)
      expect(assessSuitability(samples, 0.2, {}, found).verdict).toBe('unsuitable')
    }
    const atLimit = samples.map((s) => detectedPeople(s.t, [{ box: around, score: PERSON_MIN_SCORE }]))
    expect(assessSuitability(samples, 0.2, {}, atLimit).verdict).toBe('good')
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

  it('keeps the animals the detector finds with the people, their scores rounded down like the people’s', () => {
    const cat = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }
    expect(detectedPeople(0.4, [{ box: around, score: 0.61 }], [{ box: cat, score: 0.4569 }])).toEqual({
      t: 0.4,
      boxes: [around],
      scores: [0.61],
      animals: [cat],
      animalScores: [0.456],
    })
    expect(detectedPeople(0.4, [{ box: around, score: 0.61 }])).not.toHaveProperty('animals')
  })

  /** 6 s at 5 detections a second, with the subject's box a person where `person(i)` holds and an animal elsewhere. */
  const labelled = (person: (i: number) => boolean, animal = around) =>
    Array.from({ length: 30 }, (_, i) => ({
      t: i * 0.2,
      boxes: person(i) ? [around] : [],
      scores: person(i) ? [0.6] : [],
      ...(person(i) ? {} : { animals: [animal], animalScores: [0.6] }),
    }))
  const subjectFor = (people: ReadonlyArray<{ t: number }>) => people.map((p) => ({ t: p.t, mask: subject }))

  it('rules out a "person" the detector calls an animal more often, as in a close-up of a cat', () => {
    const cat = labelled((i) => i % 3 === 0)
    const withoutAnimals = cat.map(({ t, boxes, scores }) => ({ t, boxes, scores }))
    expect(assessSuitability(subjectFor(cat), 0.2, {}, withoutAnimals).verdict).toBe('good')
    expect(assessSuitability(subjectFor(cat), 0.2, {}, cat)).toMatchObject({
      verdict: 'unsuitable',
      reasons: ['no-subject'],
    })
  })

  it('keeps a person the detector calls an animal now and then, and a person beside an animal', () => {
    const sometimes = labelled((i) => i % 3 !== 0)
    expect(assessSuitability(subjectFor(sometimes), 0.2, {}, sometimes).verdict).toBe('good')
    const dog = { x: 44 / W, y: 26 / H, width: 16 / W, height: 10 / H }
    const walker = Array.from({ length: 30 }, (_, i) => ({
      t: i * 0.2,
      boxes: [around],
      scores: [0.6],
      animals: [dog],
      animalScores: [0.8],
    }))
    expect(assessSuitability(subjectFor(walker), 0.2, {}, walker).verdict).toBe('good')
  })

  it('keeps a person called a person exactly as often as an animal, and rules them out with one animal call more', () => {
    const at = (t: number, person: boolean) =>
      person
        ? { t, boxes: [around], scores: [0.6] }
        : { t, boxes: [], animals: [around], animalScores: [0.6] }
    const tie = [at(0, true), at(0.2, false), at(0.4, true), at(0.6, false)]
    expect(peopleNear(tie, 0.2)).toEqual([around, around])
    expect(peopleNear([...tie, at(0.8, false)], 0.2)).toEqual([])
  })
  it('counts the votes near each box, so an animal earlier in the shot does not rule out a person later', () => {
    // 20 s: a cat for the first 10 s, then from 12 s a person in the same place.
    const people = Array.from({ length: 100 }, (_, i) => {
      const t = i * 0.2
      return t < 10
        ? { t, boxes: [], animals: [around], animalScores: [0.6] }
        : { t, boxes: t >= 12 ? [around] : [], scores: t >= 12 ? [0.6] : [] }
    })
    expect(peopleNear(people, 12)).not.toEqual([])
    expect(peopleNear(people, 16)).not.toEqual([])
  })

  it('counts the votes over at least 15 samples on a long shot, whose quick check samples further apart', () => {
    // 60 s in 90 samples, one every 0.67 s: a person, called an animal in two of every three samples from 24 s to 34 s.
    const interval = 60 / 90
    const people = Array.from({ length: 90 }, (_, i) => {
      const person = i < 36 || i > 50 || i % 3 === 2
      return {
        t: i * interval,
        boxes: person ? [around] : [],
        scores: person ? [0.6] : [],
        ...(person ? {} : { animals: [around], animalScores: [0.6] }),
      }
    })
    expect(peopleNear(people, 44 * interval)).not.toEqual([])
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
