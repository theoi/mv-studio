import { describe, expect, it } from 'vitest'
import { predictCameraMove } from '../../../src/vision/cameraPrediction.ts'
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
    const { safe, alwaysBends } = await predict(edge, 'pan-right', ['pan-right', 'crane-up'])
    expect(safe.bend).toBeGreaterThanOrEqual(0.25)
    expect(alwaysBends).toBe(false)
  })
})
