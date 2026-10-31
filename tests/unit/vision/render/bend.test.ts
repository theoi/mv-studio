import { describe, expect, it } from 'vitest'
import { BEND_LIMIT, BEND_PX, bendAt, bendOf, straightLines } from '../../../../src/vision/render/bend.ts'
import { localContrast, safeAmounts, type DepthField } from '../../../../src/vision/render/smear.ts'
import type { CameraPose, GrayImage } from '../../../../src/vision/types.ts'

const W = 480
const H = 270

function image(value: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = value(x, y)
  return { width: W, height: H, data }
}
const field = (value: (x: number, y: number) => number): DepthField => image(value)

/** A vertical edge down the whole frame: dark on the left, bright on the right. */
const edge = straightLines(image((x) => (x < W / 2 ? 40 : 200)))
/** Depth that rises and falls along a line, like the windows of a facade the model gives depths of their own. */
const wave = (y: number) => 30 * Math.sin((2 * Math.PI * y) / 40)
const sideways = (offsetX: number): CameraPose => ({ offsetX, offsetY: 0, zoom: 1, focus: 0.5 })

describe('straightLines', () => {
  it('finds the edges of a rectangle as straight lines of their length and direction', () => {
    const { lines } = straightLines(image((x, y) => (x >= 240 && x < 400 && y >= 20 && y < 250 ? 200 : 40)))
    const vertical = lines.filter((l) => Math.abs(l.dx) < 0.05)
    const horizontal = lines.filter((l) => Math.abs(l.dy) < 0.05)
    expect(lines).toHaveLength(4)
    expect(vertical.map((l) => Math.round(l.x / 10) * 10).sort()).toEqual([240, 400])
    expect(horizontal.map((l) => Math.round(l.y / 10) * 10).sort()).toEqual([20, 250])
    for (const l of vertical) expect(Math.abs(l.to - l.from - 230)).toBeLessThan(10)
    for (const l of horizontal) expect(Math.abs(l.to - l.from - 160)).toBeLessThan(10)
  })

  it('finds no lines in a random texture like foliage or gravel', () => {
    let seed = 1
    const noise = Float32Array.from({ length: W * H }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed / 2147483648) * 255
    })
    const at = (x: number, y: number) =>
      noise[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]!
    const texture = image((x, y) => (at(x, y) + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1)) / 4)
    expect(straightLines(texture).lines).toEqual([])
  })
})

describe('bendAt', () => {
  it('bends a line whose depth rises and falls along it, by more as the camera moves more', () => {
    const facade = field((_, y) => 128 + wave(y))
    expect(bendAt(sideways(0.03), edge, facade)).toBeGreaterThan(BEND_LIMIT)
    // 0.005 × 30/255 × 1920 ≈ 1.1 px: under BEND_PX.
    expect(BEND_PX).toBeGreaterThan(1.2)
    expect(bendAt(sideways(0.005), edge, facade)).toBe(0)
  })

  it('keeps a line straight where its depth is even or changes steadily', () => {
    expect(
      bendAt(
        sideways(0.05),
        edge,
        field(() => 128),
      ),
    ).toBe(0)
    expect(
      bendAt(
        sideways(0.05),
        edge,
        field((_, y) => 20 + (200 * y) / H),
      ),
    ).toBe(0)
  })

  it('does not count a gentle bow over the whole line', () => {
    // About 45 px between the middle and the ends of the line, but well under BEND_PX over any tenth of the width.
    const bow = field((_, y) => 20 + 200 * ((y - H / 2) / (H / 2)) ** 2)
    expect(bendAt(sideways(0.03), edge, bow)).toBe(0)
  })

  it('reads only the near side of an outline', () => {
    // The far side waves and the near side is even: the line is the outline of the near side, which moves as one.
    const farWaves = field((x, y) => (x < W / 2 ? 40 + wave(y) : 220))
    expect(bendAt(sideways(0.03), edge, farWaves)).toBe(0)
    const nearWaves = field((x, y) => (x < W / 2 ? 200 + wave(y) / 2 : 20))
    expect(bendAt(sideways(0.06), edge, nearWaves)).toBeGreaterThan(BEND_LIMIT)
  })

  it('does not count something in front crossing the line as a bend', () => {
    const pole = field((_, y) => (y >= 130 && y < 140 ? 240 : 100))
    expect(bendAt(sideways(0.03), edge, pole)).toBe(0)
  })
})

describe('safe amount for bending', () => {
  const facade = field((_, y) => 128 + wave(y))
  const contrast = localContrast(image((x) => (x < W / 2 ? 40 : 200)))

  it('is the last amount in 0.05 steps up to which every step stays under the limit', () => {
    const { bend } = safeAmounts({ depth: facade, contrast, lines: edge }, 'orbit-left', 0.5)
    expect(bend).toBeGreaterThan(0)
    expect(bend).toBeLessThan(0.5)
    expect(Math.round(bend * 20)).toBe(bend * 20)
    const at = (intensity: number) =>
      bendOf({ depth: facade, lines: edge }, { preset: 'orbit-left', intensity, focus: 0.5 })
    for (let step = 1; step <= bend * 20; step++) expect(at(step / 20)).toBeLessThanOrEqual(BEND_LIMIT)
    expect(at(bend + 0.05)).toBeGreaterThan(BEND_LIMIT)
  })

  it('is the full amount for a scene without lines', () => {
    expect(safeAmounts({ depth: facade, contrast }, 'orbit-left', 0.5).bend).toBe(1)
  })
})
