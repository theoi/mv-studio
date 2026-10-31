import { describe, expect, it } from 'vitest'
import {
  colorBins,
  colorModel,
  withDistractor,
  type ColorModel,
} from '../../../../src/vision/segmentation/appearance.ts'
import type { Mask, RgbaImage } from '../../../../src/vision/types.ts'

/** 10x10 picture: a red-and-black object in the left half, grey elsewhere, and its mask. */
function scene(): { bins: Uint8Array; mask: Mask } {
  const data = new Uint8ClampedArray(10 * 10 * 4)
  const mask = new Uint8Array(100)
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++) {
      const object = x < 5
      const c = object ? (y < 5 ? [220, 30, 30] : [10, 10, 10]) : [128, 128, 128]
      data.set([c[0]!, c[1]!, c[2]!, 255], (y * 10 + x) * 4)
      if (object) mask[y * 10 + x] = 255
    }
  const rgba: RgbaImage = { width: 10, height: 10, data }
  return { bins: colorBins(rgba), mask: { width: 10, height: 10, data: mask } }
}

const scoreOf = (model: ColorModel, bins: Uint8Array, i: number) => model.foreground[bins[i]!]!

describe('colour model', () => {
  it('counts a rejected distractor’s colours as background, keeping the colours only the object has', () => {
    const { bins, mask } = scene()
    const model = colorModel(bins, mask)!
    const red = 0
    const black = 9 * 10
    expect(scoreOf(model, bins, red)).toBeGreaterThan(0.9)
    expect(scoreOf(model, bins, black)).toBeGreaterThan(0.9)
    // Something all black next to the object was rejected.
    const distractor = new Float32Array(model.target.length)
    distractor[bins[black]!] = 1
    const next = withDistractor(model, distractor)
    expect(scoreOf(next, bins, red)).toBeGreaterThan(0.9)
    expect(scoreOf(next, bins, black)).toBeLessThan(0.7)
    expect(next.self).toBeLessThan(model.self)
  })
})
