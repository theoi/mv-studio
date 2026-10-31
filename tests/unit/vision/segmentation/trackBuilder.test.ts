import { describe, expect, it } from 'vitest'
import { resizeMask } from '../../../../src/vision/mask/ops.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import {
  createMaskTrackBuilder,
  preferHq,
  type MaskTrackBuildConfig,
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
