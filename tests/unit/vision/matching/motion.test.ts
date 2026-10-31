import { describe, expect, it } from 'vitest'
import {
  createMotionAnalyzer,
  estimateGlobalShift,
  estimateSubpixelShift,
  frameDifference,
  histogramDistance,
  rgbaToGray,
} from '../../../../src/vision/matching/motion.ts'
import type { GrayImage, MotionAnalysis } from '../../../../src/vision/types.ts'
import { createRng, crop, makeTexture } from './helpers.ts'

const W = 160
const H = 90

function analyze(frames: GrayImage[], fps: number): MotionAnalysis {
  const analyzer = createMotionAnalyzer({ fps })
  frames.forEach((f, i) => analyzer.push(i / fps, f))
  return analyzer.finish()
}

function panFrames(count: number, stepX: number, stepY: number, seed: number, offset = 0): GrayImage[] {
  const margin = 4 + Math.abs(stepX * count) + Math.abs(stepY * count)
  const big = makeTexture(W + 2 * margin, H + 2 * margin, createRng(seed), offset)
  return Array.from({ length: count }, (_, i) => crop(big, margin - i * stepX, margin - i * stepY, W, H))
}

describe('rgbaToGray', () => {
  it('converts with Rec.601 luma at full size', () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    const gray = rgbaToGray({ width: 4, height: 1, data }, 4, 1)
    expect(Array.from(gray.data)).toEqual([76, 150, 29, 255])
  })

  it('area-averages when downsampling', () => {
    // 4x2: left half black, right half white, alpha ignored.
    const data = new Uint8Array(4 * 2 * 4)
    for (let y = 0; y < 2; y++) {
      for (let x = 2; x < 4; x++) data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 3)
    }
    const gray = rgbaToGray({ width: 4, height: 2, data }, 2, 1)
    expect(gray.width).toBe(2)
    expect(gray.height).toBe(1)
    expect(Array.from(gray.data)).toEqual([0, 255])

    const avg = rgbaToGray({ width: 4, height: 2, data }, 1, 1)
    expect(avg.data[0]).toBeGreaterThanOrEqual(127)
    expect(avg.data[0]).toBeLessThanOrEqual(128)
  })

  it('handles non-integer scale factors', () => {
    const data = new Uint8ClampedArray(5 * 3 * 4).fill(200)
    const gray = rgbaToGray({ width: 5, height: 3, data }, 2, 2)
    expect(Array.from(gray.data)).toEqual([200, 200, 200, 200])
  })
})

describe('estimateGlobalShift', () => {
  it.each([
    [5, -3],
    [-4, 6],
    [7, 0],
    [0, -1],
  ])('recovers content shift (%i, %i)', (dx, dy) => {
    const big = makeTexture(W + 40, H + 40, createRng(11))
    const prev = crop(big, 20, 20, W, H)
    const cur = crop(big, 20 - dx, 20 - dy, W, H)
    const shift = estimateGlobalShift(prev, cur)
    expect(Math.abs(shift.dx - dx)).toBeLessThanOrEqual(1)
    expect(Math.abs(shift.dy - dy)).toBeLessThanOrEqual(1)
    expect(shift.residual).toBeLessThan(2)
    expect(frameDifference(prev, cur)).toBeGreaterThan(5)
  })

  it('reports no shift for identical frames', () => {
    const img = makeTexture(W, H, createRng(3))
    expect(estimateGlobalShift(img, img)).toEqual({ dx: 0, dy: 0, residual: 0 })
  })
})

describe('estimateSubpixelShift', () => {
  const smooth = (dx: number, dy: number): GrayImage => {
    const data = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = x - dx
        const v = y - dy
        data[y * W + x] = Math.round(
          128 + 60 * Math.sin(u * 0.21 + v * 0.13) + 40 * Math.sin(u * 0.07 - v * 0.17),
        )
      }
    return { width: W, height: H, data }
  }

  it('measures shifts of a fraction of a pixel that whole-pixel search reports as none', () => {
    const prev = smooth(0, 0)
    const cur = smooth(0.4, -0.3)
    expect(estimateGlobalShift(prev, cur)).toMatchObject({ dx: 0, dy: 0 })
    const shift = estimateSubpixelShift(prev, cur)
    expect(shift.dx).toBeCloseTo(0.4, 1)
    expect(shift.dy).toBeCloseTo(-0.3, 1)
  })

  it('keeps whole-pixel shifts', () => {
    const shift = estimateSubpixelShift(smooth(0, 0), smooth(3, -2))
    expect(shift.dx).toBeCloseTo(3, 1)
    expect(shift.dy).toBeCloseTo(-2, 1)
  })
})
describe('histogramDistance', () => {
  it('is 0 for identical and 1 for disjoint histograms', () => {
    const img = makeTexture(W, H, createRng(5))
    expect(histogramDistance(img, img)).toBe(0)
    const dark: GrayImage = { width: 4, height: 4, data: new Uint8Array(16).fill(10) }
    const bright: GrayImage = { width: 4, height: 4, data: new Uint8Array(16).fill(240) }
    expect(histogramDistance(dark, bright)).toBeCloseTo(1, 6)
  })
})

describe('createMotionAnalyzer', () => {
  it('measures subject motion without camera motion for a moving square', () => {
    const fps = 10
    const bg = makeTexture(W, H, createRng(21))
    const frames = Array.from({ length: 10 }, (_, i) => {
      const data = bg.data.slice()
      for (let y = 30; y < 50; y++) data.fill(255, y * W + 20 + 4 * i, y * W + 40 + 4 * i)
      return { width: W, height: H, data }
    })
    const m = analyze(frames, fps)
    expect(m.energy).toHaveLength(9)
    expect(m.meanEnergy).toBeGreaterThan(1)
    expect(m.meanCamera).toBeLessThan(0.5)
    expect(m.cuts).toEqual([])
  })

  it('attributes a whole-frame pan to the camera, not to energy', () => {
    const fps = 10
    const frames = panFrames(10, 3, 0, 31)
    const m = analyze(frames, fps)
    const rawMean =
      frames.slice(1).reduce((s, f, i) => s + frameDifference(frames[i]!, f), 0) / (frames.length - 1)
    expect(m.camera).toHaveLength(9)
    expect(m.meanCamera).toBeCloseTo((3 / W) * 100 * fps, 0)
    expect(m.meanEnergy).toBeLessThan(0.1 * rawMean)
    expect(m.cuts).toEqual([])
  })

  it('detects an abrupt scene change at the time of the later frame', () => {
    const fps = 10
    const a = panFrames(10, 1, 0, 41)
    const b = panFrames(10, 1, 0, 42, 90)
    const m = analyze([...a, ...b], fps)
    expect(m.cuts).toHaveLength(1)
    expect(m.cuts[0]).toBeCloseTo(1.0, 6)
    // The cut pair's difference must not show up as motion.
    expect(Math.max(...m.energy)).toBeLessThan(5)
    expect(Math.max(...m.camera)).toBeLessThan(10)
  })

  it('does not report cuts for a fast smooth pan that starts abruptly', () => {
    const fps = 10
    const still = panFrames(1, 0, 0, 51)
    const frames = [still[0]!, still[0]!, still[0]!, ...panFrames(12, 6, 2, 51)]
    expect(analyze(frames, fps).cuts).toEqual([])
  })

  it('returns zeros without NaN for empty and single-frame input', () => {
    const expected: MotionAnalysis = {
      fps: 5,
      energy: [],
      camera: [],
      cuts: [],
      meanEnergy: 0,
      p90Energy: 0,
      meanCamera: 0,
    }
    expect(createMotionAnalyzer({ fps: 5 }).finish()).toEqual(expected)
    const one = createMotionAnalyzer({ fps: 5 })
    one.push(0, makeTexture(16, 9, createRng(1)))
    expect(one.finish()).toEqual(expected)
  })

  it('computes p90 of the energy curve', () => {
    const fps = 10
    const bg = makeTexture(W, H, createRng(61))
    // Square moves only in the last two steps, so p90 is well above the mean.
    const frames = Array.from({ length: 11 }, (_, i) => {
      const data = bg.data.slice()
      const x = 20 + Math.max(0, i - 8) * 15
      for (let y = 30; y < 60; y++) data.fill(255, y * W + x, y * W + x + 30)
      return { width: W, height: H, data }
    })
    const m = analyze(frames, fps)
    expect(m.p90Energy).toBeGreaterThan(m.meanEnergy)
    expect(m.energy.slice(0, 8).every((e) => e === 0)).toBe(true)
  })
})
