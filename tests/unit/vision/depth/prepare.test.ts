import { describe, expect, it } from 'vitest'
import { prepareDepthForParallax, suggestFocus } from '../../../../src/vision/depth/prepare.ts'
import type { DepthMap } from '../../../../src/vision/types.ts'

function depthMap(width: number, height: number, value: (x: number, y: number) => number): DepthMap {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = value(x, y)
  return {
    version: 1,
    width,
    height,
    data,
    sourceSize: { width: width * 4, height: height * 4 },
    model: 'test',
    quality: 'preview',
  }
}

const at = (m: DepthMap, x: number, y: number) => m.data[y * m.width + x]!
const count = (m: DepthMap, pred: (v: number) => boolean) => m.data.reduce((n, v) => n + (pred(v) ? 1 : 0), 0)

describe('prepareDepthForParallax', () => {
  it('stretches the robust range to 0..255 and ignores a few outliers', () => {
    // A horizontal ramp 100..150 with 1 % of pixels (half of the last row) at the extremes.
    const m = depthMap(200, 50, (x, y) =>
      y === 49 && x < 100 ? (x % 2 ? 255 : 0) : 100 + Math.round((x / 199) * 50),
    )
    const out = prepareDepthForParallax(m, { dilate: 0, blur: 0, thinRadius: 0 })
    const ramp = (x: number) => at(out, x, 1)
    expect(ramp(2)).toBeLessThan(15)
    expect(ramp(197)).toBeGreaterThan(240)
    for (let x = 2; x < 197; x++) expect(ramp(x + 1)).toBeGreaterThanOrEqual(ramp(x))
    expect(out.width).toBe(m.width)
    expect(out.sourceSize).toEqual(m.sourceSize)
    expect(at(m, 1, 49)).toBe(255)
    expect(at(out, 1, 49)).toBe(255)
    expect(at(out, 0, 49)).toBe(0)
  })

  it('does not amplify a nearly flat map into strong relief', () => {
    const m = depthMap(64, 64, (x, y) => 128 + ((x + y) % 5) - 2)
    const out = prepareDepthForParallax(m, { dilate: 0, blur: 0, thinRadius: 0 })
    expect(Math.max(...out.data) - Math.min(...out.data)).toBeLessThan(64)
  })

  it('dilation grows the near region beyond the subject silhouette', () => {
    const disk = depthMap(100, 60, (x, y) => (Math.hypot(x - 50, y - 30) <= 10 ? 230 : 20))
    const plain = prepareDepthForParallax(disk, { dilate: 0, blur: 0, thinRadius: 0 })
    const dilated = prepareDepthForParallax(disk, { dilate: 0.05, blur: 0, thinRadius: 0 })
    const near = (v: number) => v >= 128
    expect(count(dilated, near)).toBeGreaterThan(count(plain, near) * 1.8)
    expect(near(at(plain, 64, 30))).toBe(false)
    expect(near(at(dilated, 64, 30))).toBe(true)
    expect(near(at(dilated, 50, 30))).toBe(true)
    expect(at(dilated, 0, 0)).toBe(at(plain, 0, 0))
  })

  it('sharpens a soft depth edge into a step but leaves a gentle gradient alone', () => {
    const soft = depthMap(120, 10, (x) => Math.max(0, Math.min(255, Math.round((x - 54) * 21))))
    const gentle = depthMap(120, 10, (x) => Math.round(x * 2))
    const opts = { dilate: 0, blur: 0, thinRadius: 0, sharpen: 0.05 }
    const mid = (m: DepthMap) =>
      Array.from({ length: 120 }, (_, x) => at(m, x, 5)).filter((v) => v > 10 && v < 245).length
    expect(mid(prepareDepthForParallax(soft, { ...opts, sharpen: 0 }))).toBeGreaterThanOrEqual(10)
    expect(mid(prepareDepthForParallax(soft, opts))).toBe(0)
    const g0 = prepareDepthForParallax(gentle, { ...opts, sharpen: 0 })
    const g1 = prepareDepthForParallax(gentle, opts)
    expect(Array.from(g1.data)).toEqual(Array.from(g0.data))
  })

  it('blurs the dilated step into a short ramp', () => {
    const step = depthMap(100, 20, (x) => (x < 50 ? 0 : 255))
    const hard = prepareDepthForParallax(step, { dilate: 0, blur: 0, thinRadius: 0 })
    const soft = prepareDepthForParallax(step, { dilate: 0, blur: 0.03, thinRadius: 0 })
    const mid = (m: DepthMap) =>
      Array.from({ length: 100 }, (_, x) => at(m, x, 10)).filter((v) => v > 20 && v < 235).length
    expect(mid(hard)).toBe(0)
    expect(mid(soft)).toBeGreaterThanOrEqual(4)
    expect(at(soft, 0, 10)).toBe(0)
    expect(at(soft, 99, 10)).toBe(255)
  })

  it('ramps long around thin near structures and short beside a large near region', () => {
    // A wide near block, and near posts 2 px wide every 20 px, over a far background.
    const m = depthMap(240, 60, (x) => ((x >= 20 && x < 90) || (x >= 140 && x % 20 < 2) ? 230 : 20))
    const ramped = (out: DepthMap, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => at(out, from + i, 30)).filter((v) => v > 40 && v < 210)
        .length
    const both = prepareDepthForParallax(m)
    const shortOnly = prepareDepthForParallax(m, { thinRadius: 0 })
    // Beside the block: the short ramp, as if there were no thin structures at all.
    expect(ramped(both, 90, 125)).toBe(ramped(shortOnly, 90, 125))
    expect(ramped(both, 90, 125)).toBeLessThanOrEqual(4)
    // Between the posts the long ramp leaves no flat background, the short one does.
    expect(ramped(both, 162, 178)).toBeGreaterThan(2 * ramped(shortOnly, 162, 178))
  })

  it('rejects maps whose data does not match their size', () => {
    const m = depthMap(10, 10, () => 0)
    expect(() => prepareDepthForParallax({ ...m, width: 11 })).toThrow(/expected 110/)
  })
})

describe('suggestFocus', () => {
  it('picks the centred subject rather than a small nearer object at the edge or the background', () => {
    const m = depthMap(160, 90, (x, y) => {
      if (x < 12 && y > 70) return 255
      if (Math.abs(x - 80) < 25 && Math.abs(y - 50) < 35) return 200
      return 40
    })
    const focus = suggestFocus(m)
    expect(focus).toBeGreaterThan(190 / 255)
    expect(focus).toBeLessThan(210 / 255)
  })

  it('returns the depth of a uniform map', () => {
    expect(suggestFocus(depthMap(50, 50, () => 100))).toBeCloseTo(100 / 255, 5)
  })
})
