import { describe, expect, it } from 'vitest'
import { cleanAlternatives, predictCameraMove } from '../../../src/vision/cameraPrediction.ts'
import type { CameraPreset } from '../../../src/vision/types.ts'

const W = 192
const H = 108
const image = (f: (x: number, y: number) => number) => {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.round(f(x, y))
  return { width: W, height: H, data }
}
const estimate = (depth: (x: number, y: number) => number) => ({
  ...image(depth),
  version: 1 as const,
  sourceSize: { width: W, height: H },
  model: 'test',
  quality: 'full' as const,
})
const wave = (v: number) => Math.sin((2 * Math.PI * v) / 16)
/** A horizontal edge over depth that rises and falls along it: moves that push it up or down bend it. */
const edge = { estimate: estimate((x) => 128 + 90 * wave(x)), gray: image((_, y) => (y < H / 3 ? 40 : 200)) }
/** The same edge over a wave twice as long: orbit and drift neither bend nor smear it at 0.25. */
const wideEdge = {
  estimate: estimate((x) => 128 + 90 * wave(x / 2)),
  gray: image((_, y) => (y < H / 3 ? 40 : 200)),
}
/** A checkerboard over depth that waves both ways on a ramp toward the bottom: every Motion bends some of its edges. */
const grid = {
  estimate: estimate((x, y) => 40 + 1.5 * y + 15 * wave(x) + 15 * wave(y)),
  gray: image((x, y) => ((Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? 40 : 200)),
}
const MOTIONS: CameraPreset[] = ['dolly-in', 'orbit-right', 'pan-right']
const predict = (source: typeof edge, preset: CameraPreset, presets?: CameraPreset[]) =>
  predictCameraMove({ source, preset, ...(presets ? { alternatives: { presets, floor: 0.25 } } : {}) })

describe('a camera move whose preset bends straight lines even at the lowest automatic amount', () => {
  it('always bends when every alternative bends them below that amount too', async () => {
    const { safe, alwaysBends } = await predict(grid, 'dolly-in', MOTIONS)
    expect(safe.bend).toBeLessThan(0.25)
    expect(alwaysBends).toBe(true)
    // Tilt keeps the grid's lines under the bend limit up to about 0.45, so with it there is a choice that helps.
    expect((await predict(grid, 'dolly-in', [...MOTIONS, 'tilt-up'])).alwaysBends).toBe(false)
  })

  it('does not when an alternative keeps them straight at that amount, or without alternatives', async () => {
    const { safe, alwaysBends } = await predict(edge, 'dolly-in', MOTIONS)
    expect(safe.bend).toBeLessThan(0.25)
    // Drift and orbit move the edge along itself.
    expect(alwaysBends).toBe(false)
    expect((await predict(edge, 'dolly-in', ['dolly-in', 'crane-up'])).alwaysBends).toBe(true)
    expect((await predict(edge, 'dolly-in')).alwaysBends).toBe(false)
  })

  it('does not when the preset itself keeps them straight at that amount', async () => {
    const { safe, alwaysBends, cleanAlternatives } = await predict(edge, 'pan-right', [
      'pan-right',
      'crane-up',
    ])
    expect(safe.bend).toBeGreaterThanOrEqual(0.25)
    expect(alwaysBends).toBe(false)
    expect(cleanAlternatives).toEqual([])
  })
})

describe('the alternatives that keep a still clean at the lowest automatic amount', () => {
  it('are the other presets under both limits at that amount, the one that can move the most first', async () => {
    const { cleanAlternatives: clean } = await predict(wideEdge, 'dolly-in', MOTIONS)
    const own = await Promise.all(
      (['orbit-right', 'pan-right'] as const).map(async (p) => {
        const { safe } = await predict(wideEdge, p)
        return { preset: p, amount: Math.min(safe.smear, safe.bend) }
      }),
    )
    const expected = own
      .filter((o) => o.amount >= 0.25)
      .sort((a, b) => b.amount - a.amount)
      .map((o) => o.preset)
    expect(expected.length).toBeGreaterThan(0)
    expect(clean).toEqual(expected)
  })

  it('are none where every alternative bends the lines too, or without alternatives', async () => {
    expect((await predict(grid, 'dolly-in', MOTIONS)).cleanAlternatives).toEqual([])
    expect((await predict(wideEdge, 'dolly-in')).cleanAlternatives).toEqual([])
  })

  it('leave out one that keeps the lines straight but smears at that amount', async () => {
    // Over depth that rises and falls every 8 columns, orbit and drift move the edge along itself but smear below 0.25.
    const { alwaysBends, cleanAlternatives: clean } = await predict(edge, 'dolly-in', MOTIONS)
    expect(alwaysBends).toBe(false)
    expect((await predict(edge, 'pan-right')).safe.smear).toBeLessThan(0.25)
    expect(clean).toEqual([])
  })

  it('leave out one that smears below that amount, and keep the order of a tie', () => {
    const safe = (smear: number, bend: number) => ({ smear, bend })
    expect(
      cleanAlternatives(
        [
          { preset: 'dolly-in', safe: safe(0.2, 1) },
          { preset: 'orbit-right', safe: safe(0.6, 0.3) },
          { preset: 'pan-right', safe: safe(1, 0.45) },
          { preset: 'tilt-up', safe: safe(0.3, 1) },
        ],
        0.25,
      ),
    ).toEqual(['pan-right', 'orbit-right', 'tilt-up'])
    expect(
      cleanAlternatives(
        [
          { preset: 'orbit-right', safe: safe(0.5, 0.5) },
          { preset: 'pan-right', safe: safe(0.5, 1) },
        ],
        0.25,
      ),
    ).toEqual(['orbit-right', 'pan-right'])
  })
})
