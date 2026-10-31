import { describe, expect, it } from 'vitest'
import { cameraPoseAt } from '../../../../src/vision/render/camera.ts'
import {
  SMEAR_LIMIT,
  createParallaxSampler,
  localContrast,
  safeIntensity,
  smearAt,
  smearOf,
  type DepthField,
  type SmearScene,
} from '../../../../src/vision/render/smear.ts'
import { prepareDepthForParallax } from '../../../../src/vision/depth/prepare.ts'
import type { CameraPose } from '../../../../src/vision/types.ts'

const W = 192
const H = 108

function field(value: (x: number, y: number) => number): DepthField {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = value(x, y)
  return { width: W, height: H, data }
}

/** Thin near posts (a fence) over a far background, like branches in front of a mountainside. */
const fence = field((x) => (x % 16 < 3 ? 240 : 20))
const flat = field(() => 90)
/** A detailed background everywhere: a fine checkerboard. */
const textured = localContrast({
  width: W,
  height: H,
  data: Uint8Array.from({ length: W * H }, (_, i) => ((((i % W) >> 1) + ((i / W) >> 1)) % 2 ? 200 : 60)),
})
const plain = localContrast({ width: W, height: H, data: new Uint8Array(W * H).fill(128) })

describe('createParallaxSampler', () => {
  it('shifts a flat scene by the offset times its distance from the focus plane, like the shader', () => {
    const pose: CameraPose = {
      offsetX: 0.04,
      offsetY: -0.02,
      zoom: 1.2,
      focus: 0.3,
      panX: 0.01,
      panY: 0,
      dolly: 0.1,
    }
    const sample = createParallaxSampler(flat)(pose)
    for (const [u, v] of [
      [0.5, 0.5],
      [0.1, 0.8],
      [0.9, 0.2],
    ] as const) {
      const px = 0.5 + (u - 0.5) / 1.2 - 0.01
      const py = 0.5 + (v - 0.5) / 1.2
      const k = 90 / 255 - 0.3
      const [qx, qy] = sample(u, v)
      expect(qx).toBeCloseTo(px - (0.04 + (px - 0.5) * 0.1) * k, 3)
      expect(qy).toBeCloseTo(py - (-0.02 + (py - 0.5) * 0.1) * k, 3)
    }
  })

  it('lets near content occlude far content', () => {
    // Near block on the left half; a camera offset pulls far samples under it, where the block must win.
    const block = field((x) => (x < W / 2 ? 255 : 0))
    const pose: CameraPose = { offsetX: 0.1, offsetY: 0, zoom: 1, focus: 0.5 }
    const [qx] = createParallaxSampler(block)(pose)(0.52, 0.5)
    // On the far layer this point would be sampled at 0.52 + 0.05 = 0.57 (right half); it shows the block instead.
    expect(qx).toBeLessThan(0.5)
  })
})

describe('smear prediction', () => {
  it('finds smear behind thin occluders on a detailed background, and none on a flat scene', () => {
    const move = { preset: 'orbit-left' as const, intensity: 0.5, focus: 0.5 }
    expect(smearOf({ depth: fence, contrast: textured }, move)).toBeGreaterThan(SMEAR_LIMIT)
    expect(smearOf({ depth: flat, contrast: textured }, move)).toBe(0)
  })

  it('does not count stretched background without detail', () => {
    const move = { preset: 'orbit-left' as const, intensity: 1, focus: 0.5 }
    expect(smearOf({ depth: fence, contrast: plain }, move)).toBe(0)
  })

  it('grows with the amount and is zero for a still frame', () => {
    const scene = { depth: fence, contrast: textured }
    const at = (intensity: number) => smearOf(scene, { preset: 'dolly-in', intensity, focus: 0.5 })
    expect(at(0)).toBe(0)
    expect(at(0.25)).toBeLessThan(at(0.5))
    expect(at(0.5)).toBeLessThan(at(1))
  })

  it('ignores the uniform zoom of the move', () => {
    const pose = cameraPoseAt({ preset: 'ken-burns', intensity: 1, focus: 0.5 }, 1)
    expect(pose.zoom).toBeGreaterThan(1.1)
    expect(smearAt(createParallaxSampler(flat)(pose), pose.zoom, textured)).toBe(0)
  })

  it('the parallax preparation merges dense thin occluders into one layer that barely smears', () => {
    // Twigs 2 px wide every 24 px with soft model edges, at a depth map's typical size.
    const w = 480
    const h = 270
    const data = new Uint8Array(w * h)
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(((i % w) % 24) - 1) - 1
      data[i] = Math.round(20 + 220 * Math.min(1, Math.max(0, 1 - d / 4)))
    }
    const raw = { version: 1 as const, width: w, height: h, data, sourceSize: { width: w, height: h } }
    const contrast = localContrast({
      width: w,
      height: h,
      data: Uint8Array.from({ length: w * h }, (_, i) => ((((i % w) >> 1) + ((i / w) >> 1)) % 2 ? 200 : 60)),
    })
    const prepared = (options?: { thinRadius: number }): SmearScene => ({
      depth: prepareDepthForParallax({ ...raw, model: 'test', quality: 'full' }, options),
      contrast,
    })
    const move = { preset: 'orbit-left' as const, intensity: 0.5, focus: 0.5 }
    const narrowRamp = smearOf(prepared({ thinRadius: 0 }), move)
    expect(narrowRamp).toBeGreaterThan(SMEAR_LIMIT * 10)
    expect(smearOf(prepared(), move)).toBeLessThan(narrowRamp / 10)
  })
})

describe('safeIntensity', () => {
  it('is the largest amount in 0.05 steps that stays under the limit', () => {
    const scene = { depth: fence, contrast: textured }
    const safe = safeIntensity(scene, 'orbit-left', 0.5)
    expect(safe).toBeLessThan(0.5)
    expect(Math.round(safe * 20)).toBe(safe * 20)
    if (safe > 0)
      expect(smearOf(scene, { preset: 'orbit-left', intensity: safe, focus: 0.5 })).toBeLessThanOrEqual(
        SMEAR_LIMIT,
      )
    expect(smearOf(scene, { preset: 'orbit-left', intensity: safe + 0.05, focus: 0.5 })).toBeGreaterThan(
      SMEAR_LIMIT,
    )
  })

  it('allows the full amount on a scene without depth edges', () => {
    expect(safeIntensity({ depth: flat, contrast: textured }, 'orbit-left', 0.5)).toBe(1)
  })
})
