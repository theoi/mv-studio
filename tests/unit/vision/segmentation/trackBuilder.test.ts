import { describe, expect, it } from 'vitest'
import { boundingBox, resizeMask } from '../../../../src/vision/mask/ops.ts'
import { POP_MIN_SHARE } from '../../../../src/vision/mask/suitability.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import {
  createMaskTrackBuilder,
  preferHq,
  type MaskTrackBuildConfig,
  type TrackFrameInput,
} from '../../../../src/vision/segmentation/trackBuilder.ts'
import type { GrayImage, Mask, RgbaImage, Size } from '../../../../src/vision/types.ts'
import { discMask, flatGray } from './fakes.ts'

const SIZE: Size = { width: 64, height: 64 }

function config(overrides: Partial<MaskTrackBuildConfig> = {}): MaskTrackBuildConfig {
  return {
    meta: {
      version: 1,
      kind: 'person',
      mediaId: 'm',
      sourceSize: { width: 640, height: 640 },
      maskSize: SIZE,
      fps: 10,
      start: 0,
      model: 'test',
      quality: 'standard',
    },
    ...overrides,
  }
}

function discRgba(size: Size, cx: number, cy: number, r: number): RgbaImage {
  const m = discMask(size, cx, cy, r)
  const data = new Uint8Array(size.width * size.height * 4)
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i]! ? 230 : 20
    data.set([v, v, v, 255], i * 4)
  }
  return { width: size.width, height: size.height, data }
}

function meanAbsError(a: Mask, b: Mask): number {
  let s = 0
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i]! - b.data[i]!)
  return s / a.data.length
}

function grayOf(rgba: RgbaImage): GrayImage {
  const data = new Uint8Array(rgba.width * rgba.height)
  for (let i = 0; i < data.length; i++) data[i] = rgba.data[i * 4]!
  return { width: rgba.width, height: rgba.height, data }
}

describe('mask track builder', () => {
  it('snaps a coarse mask to the image edges when refining', () => {
    const truth = discMask(SIZE, 32, 32, 20)
    const rgba = discRgba(SIZE, 32, 32, 20)
    const coarse = resizeMask(resizeMask(truth, 16, 16), 64, 64)
    const run = (refineFrom: number) => {
      const b = createMaskTrackBuilder(config({ refineFrom, temporal: false }))
      b.push({ mask: coarse, gray: grayOf(rgba), rgba })
      return createTrackReader(b.finish()).frame(0)
    }
    const plain = meanAbsError(run(0), truth)
    const refined = meanAbsError(run(16), truth)
    expect(plain).toBeGreaterThan(2)
    expect(refined).toBeLessThan(plain * 0.6)
  })

  it('keeps one stored frame per pushed frame with the temporal filter delay', () => {
    const b = createMaskTrackBuilder(config({ temporal: { radius: 2 } }))
    for (let i = 0; i < 7; i++) b.push({ mask: discMask(SIZE, 32, 32, 10), gray: flatGray(SIZE) })
    const track = b.finish()
    expect(track.meta.frameCount).toBe(7)
    expect(track.meta.coverage).toHaveLength(7)
    expect(track.meta.coverage[3]).toBeCloseTo((Math.PI * 100) / 4096, 1)
  })

  it('averages out flicker on a static image', () => {
    const b = createMaskTrackBuilder(config({ temporal: { radius: 2 } }))
    const n = 9
    for (let i = 0; i < n; i++) b.push({ mask: discMask(SIZE, 32, 32, i % 2 ? 12 : 8), gray: flatGray(SIZE) })
    const reader = createTrackReader(b.finish())
    // Ring between the two radii toggles 0/255 on input; filtered it settles near the mean.
    const ringPixel = 32 * 64 + 32 + 10
    const values = Array.from({ length: n - 4 }, (_, k) => reader.frame(k + 2).data[ringPixel]!)
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) expect(Math.abs(v - 127)).toBeLessThan(50)
  })

  it('follows a moving subject without lag when the guide moves with it', () => {
    const b = createMaskTrackBuilder(config({ temporal: { radius: 2 } }))
    const n = 9
    for (let i = 0; i < n; i++) {
      const rgba = discRgba(SIZE, 16 + 4 * i, 32, 8)
      b.push({ mask: discMask(SIZE, 16 + 4 * i, 32, 8), gray: grayOf(rgba) })
    }
    const reader = createTrackReader(b.finish())
    const truth = discMask(SIZE, 32, 32, 8)
    expect(meanAbsError(reader.frame(4), truth)).toBeLessThan(3)
  })

  it('rejects pushes after finish', () => {
    const b = createMaskTrackBuilder(config({ temporal: false }))
    b.finish()
    expect(() => b.push({ mask: discMask(SIZE, 1, 1, 1), gray: flatGray(SIZE) })).toThrow()
  })
})

describe('mask track builder gated to the people found', () => {
  // A person on the left and, apart from it, a patch the segmenter also takes for a person.
  const person = discMask(SIZE, 16, 32, 8)
  const patch = discMask(SIZE, 50, 32, 6)
  const both: Mask = { ...person, data: person.data.map((v, i) => Math.max(v, patch.data[i]!)) }
  const personBox = { x: 8 / 64, y: 24 / 64, width: 16 / 64, height: 16 / 64 }
  const area = (m: Mask) => m.data.filter((v) => v >= 128).length / m.data.length
  const gate = { hold: 1, carry: 2, reach: 3.95, judgeEvery: 1 }
  /** 10 s at 10 frames a second, the person found 5 times a second except from 3 to 7 s. */
  const build = (
    found: (t: number) => TrackFrameInput['found'],
    overrides: Partial<MaskTrackBuildConfig> = {},
  ) => {
    const b = createMaskTrackBuilder(config({ temporal: false, gate, ...overrides }))
    const stored: number[] = []
    for (let i = 0; i < 100; i++) {
      const t = i / 10
      b.push({ mask: both, gray: flatGray(SIZE), ...(i % 2 ? {} : { found: found(t) }) })
      stored.push(b.boxes().length)
    }
    return { track: b.finish(), boxes: b.boxes(), stored }
  }
  const seen = (t: number) => ({ people: t > 3 && t < 7 ? [] : [{ box: personBox, score: 0.9 }] })

  it('keeps only the person, carries them 2 s past the hold, and stores each mask once the detections after it are in', () => {
    const { track, boxes, stored } = build(seen)
    // Found until 3 s and from 7 s; carried from the previous kept mask until 5 s; nothing between.
    expect(track.meta.coverage).toEqual(
      Array.from({ length: 100 }, (_, i) => (i <= 50 || i >= 70 ? area(person) : 0)),
    )
    expect(boxes[0]).toEqual(boundingBox(person))
    expect(boxes[60]).toBeNull()
    // A mask waits for the detections 3.95 s after it: 6.4 s pushed, masks to 2.4 s stored.
    expect(stored[64]).toBe(25)
  })

  it('drops a part once it leaves the person boxes, though it overlapped the kept mask the frame before', () => {
    // A patch that starts inside the person's box and slides away 1 px a frame, as when the camera pans past a pillar.
    const b = createMaskTrackBuilder(config({ temporal: false, gate }))
    for (let i = 0; i < 40; i++) {
      const slide = discMask(SIZE, 22 + i, 20, 4)
      b.push({
        mask: { ...person, data: person.data.map((v, p) => Math.max(v, slide.data[p]!)) },
        gray: flatGray(SIZE),
        found: { people: [{ box: personBox, score: 0.9 }] },
      })
    }
    const coverage = b.finish().meta.coverage
    expect(coverage[0]).toBeGreaterThan(area(person))
    expect(coverage[39]).toBe(area(person))
  })

  it('keeps every mask whole when the person detector cannot be loaded', () => {
    const { track } = build(() => null)
    expect(track.meta.coverage).toEqual(Array.from({ length: 100 }, () => area(both)))
  })

  it('measures the pops of the gated masks, so a patch that blinks outside the person does not count', () => {
    const blinking = (gated: boolean) => {
      const b = createMaskTrackBuilder(config({ temporal: false, pops: true, ...(gated ? { gate } : {}) }))
      for (let i = 0; i < 40; i++)
        b.push({
          mask: i % 10 === 5 ? both : person,
          gray: flatGray(SIZE),
          found: { people: [{ box: personBox, score: 0.9 }] },
        })
      return b.finish().meta.pops!
    }
    expect(blinking(false).filter((p) => p >= POP_MIN_SHARE).length).toBeGreaterThan(0)
    expect(blinking(true).filter((p) => p >= POP_MIN_SHARE)).toEqual([])
  })

  it('notes the frames it cut down from a shape large enough for the effect, so the verdict can say no person was found', () => {
    const large = discMask(SIZE, 32, 32, 16)
    const noted = (mask: Mask, people: Array<{ box: typeof personBox; score: number }>) => {
      const b = createMaskTrackBuilder(config({ temporal: false, gate: { ...gate, judgeEvery: 2 } }))
      for (let i = 0; i < 20; i++) b.push({ mask, gray: flatGray(SIZE), found: { people } })
      return b.finish().meta.largeBeforeGate
    }
    // Only the frames the verdict judges.
    expect(noted(large, [])).toEqual(Array.from({ length: 10 }, (_, i) => i * 2))
    // Not where the cutout keeps the whole shape, nor where what it cuts is small, as in a wide shot of small people.
    expect(noted(large, [{ box: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, score: 0.9 }])).toBeUndefined()
    expect(noted(both, [])).toBeUndefined()
  })
})
describe('preferHq', () => {
  it('uses a matte that agrees with the standard mask, resized to its size', () => {
    const standard = discMask(SIZE, 32, 32, 16)
    const hq = discMask({ width: 32, height: 32 }, 16, 16, 7.5)
    const res = preferHq(standard, hq)
    expect(res.usedHq).toBe(true)
    expect(res.mask.width).toBe(64)
  })

  it('keeps the standard mask when the matte disagrees', () => {
    const standard = discMask(SIZE, 16, 16, 10)
    const hq = discMask(SIZE, 48, 48, 10)
    expect(preferHq(standard, hq)).toEqual({ mask: standard, usedHq: false })
  })
})
