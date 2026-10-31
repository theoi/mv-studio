import { describe, expect, it } from 'vitest'
import {
  CAMERA_PRESETS,
  cameraPoseAt,
  defaultCameraMove,
  requiredOverscan,
  requiredZoom,
} from '../../../../src/vision/render/camera.ts'
import type { CameraMove, CameraPose, CameraPreset } from '../../../../src/vision/types.ts'

const progresses = Array.from({ length: 101 }, (_, i) => i / 100).concat([0.013, 0.487, 0.999])

/** Image coordinates the renderer samples for output pixel `uv` at depth layer `h` (see parallax.ts). */
function sampled(pose: CameraPose, u: number, w: number, h: number): [number, number] {
  const px = 0.5 + (u - 0.5) / pose.zoom - (pose.panX ?? 0)
  const py = 0.5 + (w - 0.5) / pose.zoom - (pose.panY ?? 0)
  const vx = pose.offsetX + (px - 0.5) * (pose.dolly ?? 0)
  const vy = pose.offsetY + (py - 0.5) * (pose.dolly ?? 0)
  return [px - vx * (h - pose.focus), py - vy * (h - pose.focus)]
}

function move(preset: CameraPreset, intensity = 0.7, focus = 0.6): CameraMove {
  return { preset, intensity, focus }
}

describe('cameraPoseAt', () => {
  it('pans move from one side to the other, mirrored between left and right', () => {
    const l0 = cameraPoseAt(move('pan-left'), 0)
    const l1 = cameraPoseAt(move('pan-left'), 1)
    const r0 = cameraPoseAt(move('pan-right'), 0)
    expect(l0.offsetX).toBeLessThan(0)
    expect(l1.offsetX).toBeGreaterThan(0)
    expect(l1.offsetX).toBeCloseTo(-l0.offsetX, 10)
    expect(l1.panX!).toBeGreaterThan(0)
    expect(r0.offsetX).toBeCloseTo(-l0.offsetX, 10)
    expect(cameraPoseAt(move('pan-left'), 0.5).offsetX).toBeCloseTo(0, 10)
  })

  it('tilts and cranes move vertically: up moves content down', () => {
    const up = cameraPoseAt(move('tilt-up'), 1)
    const down = cameraPoseAt(move('tilt-down'), 1)
    expect(up.panY!).toBeGreaterThan(0)
    expect(down.panY!).toBeLessThan(0)
    expect(up.offsetX).toBe(0)
    const crane = cameraPoseAt(move('crane-up'), 1)
    expect(crane.offsetY).toBeGreaterThan(cameraPoseAt(move('crane-up'), 0).offsetY)
  })

  it('dolly-in starts undistorted and ends zoomed with near content magnified; dolly-out is its reverse', () => {
    const start = cameraPoseAt(move('dolly-in'), 0)
    const end = cameraPoseAt(move('dolly-in'), 1)
    expect(start.dolly).toBe(0)
    expect(end.dolly!).toBeGreaterThan(0.1)
    expect(end.zoom).toBeGreaterThan(start.zoom * 1.05)
    for (const t of [0, 0.3, 1]) {
      const out = cameraPoseAt(move('dolly-out'), t)
      const back = cameraPoseAt(move('dolly-in'), 1 - t)
      expect(out.zoom).toBeCloseTo(back.zoom, 10)
      expect(out.dolly!).toBeCloseTo(back.dolly!, 10)
    }
  })

  it('orbit keeps the focus plane steady while swinging the parallax offset', () => {
    const o0 = cameraPoseAt(move('orbit-left'), 0)
    const o1 = cameraPoseAt(move('orbit-left'), 1)
    expect(o0.panX ?? 0).toBe(0)
    expect(o1.offsetX).toBeGreaterThan(Math.abs(cameraPoseAt(move('pan-left'), 1).offsetX))
    expect(o0.offsetX).toBeCloseTo(-o1.offsetX, 10)
    expect(cameraPoseAt(move('orbit-right'), 1).offsetX).toBeCloseTo(-o1.offsetX, 10)
  })

  it('progresses monotonically for dolly and pan presets', () => {
    let prev = cameraPoseAt(move('dolly-in'), 0)
    let prevPan = cameraPoseAt(move('pan-right'), 0)
    for (const t of progresses.filter((p) => p > 0).sort((a, b) => a - b)) {
      const dolly = cameraPoseAt(move('dolly-in'), t)
      expect(dolly.zoom).toBeGreaterThan(prev.zoom)
      expect(dolly.dolly!).toBeGreaterThan(prev.dolly!)
      const pan = cameraPoseAt(move('pan-right'), t)
      expect(pan.offsetX).toBeLessThan(prevPan.offsetX)
      expect(pan.panX!).toBeLessThan(prevPan.panX!)
      prev = dolly
      prevPan = pan
    }
  })

  it('eases in and out: slow at the ends, fastest in the middle', () => {
    const x = (t: number) => cameraPoseAt(move('pan-left'), t).offsetX
    const startSpeed = x(0.01) - x(0)
    const midSpeed = x(0.505) - x(0.495)
    const endSpeed = x(1) - x(0.99)
    expect(startSpeed).toBeGreaterThan(0)
    expect(startSpeed).toBeLessThan(midSpeed / 20)
    expect(endSpeed).toBeLessThan(midSpeed / 20)
  })

  it('keeps the zoom constant during a pan, so hiding borders adds no zoom pulse', () => {
    const zooms = progresses.map((t) => cameraPoseAt(move('pan-left'), t).zoom)
    expect(Math.max(...zooms) - Math.min(...zooms)).toBeLessThan(1e-12)
    expect(zooms[0]).toBeGreaterThan(1.01)
  })

  it('clamps progress, intensity and focus', () => {
    expect(cameraPoseAt(move('pan-left'), -1)).toEqual(cameraPoseAt(move('pan-left'), 0))
    expect(cameraPoseAt(move('pan-left'), 5)).toEqual(cameraPoseAt(move('pan-left'), 1))
    expect(cameraPoseAt(move('pan-left'), Number.NaN)).toEqual(cameraPoseAt(move('pan-left'), 0))
    expect(cameraPoseAt(move('pan-left', 3, 2), 1)).toEqual(cameraPoseAt(move('pan-left', 1, 1), 1))
  })

  it('intensity 0 is a still frame', () => {
    for (const preset of CAMERA_PRESETS) {
      for (const t of [0, 0.5, 1]) {
        const p = cameraPoseAt(move(preset, 0), t)
        expect(
          Math.abs(p.offsetX) +
            Math.abs(p.offsetY) +
            Math.abs(p.panX ?? 0) +
            Math.abs(p.panY ?? 0) +
            Math.abs(p.dolly ?? 0),
        ).toBe(0)
        expect(p.zoom).toBeLessThan(1.01)
      }
    }
  })
})

describe('overscan', () => {
  const intensities = [0, 0.25, 0.5, 0.75, 1]
  const focuses = [0, 0.3, 0.5, 0.8, 1]

  it('every preset, intensity, focus and progress zooms at least as much as required', () => {
    let checked = 0
    for (const preset of CAMERA_PRESETS)
      for (const intensity of intensities)
        for (const focus of focuses)
          for (const t of progresses) {
            const pose = cameraPoseAt({ preset, intensity, focus }, t)
            expect(pose.zoom).toBeGreaterThanOrEqual(1)
            expect(pose.zoom).toBeGreaterThanOrEqual(requiredZoom(pose))
            checked++
          }
    expect(checked).toBe(CAMERA_PRESETS.length * intensities.length * focuses.length * progresses.length)
  })

  it('never samples outside the image at the frame edges for the extreme depth layers', () => {
    const edge = Array.from({ length: 11 }, (_, i) => i / 10)
    let worst = 0
    for (const preset of CAMERA_PRESETS)
      for (const intensity of [0.5, 1])
        for (const focus of focuses)
          for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const pose = cameraPoseAt({ preset, intensity, focus }, t)
            for (const h of [0, 1])
              for (const e of edge)
                for (const [u, w] of [
                  [e, 0],
                  [e, 1],
                  [0, e],
                  [1, e],
                ] as const) {
                  const [x, y] = sampled(pose, u, w, h)
                  worst = Math.max(worst, -x, x - 1, -y, y - 1)
                }
          }
    expect(worst).toBeLessThanOrEqual(1e-9)
  })

  it('the required zoom is tight: 2 % less samples outside the image', () => {
    for (const preset of CAMERA_PRESETS) {
      const pose = cameraPoseAt(move(preset, 1, 0.8), 1)
      const tight = { ...pose, zoom: requiredZoom(pose) * 0.98 }
      if (tight.zoom < 1) continue
      const coords = [0, 1].flatMap((h) =>
        [0, 1].flatMap((u) => [0, 1].flatMap((w) => sampled(tight, u, w, h))),
      )
      expect(Math.min(...coords) < 0 || Math.max(...coords) > 1, preset).toBe(true)
    }
  })

  it('a pan that counters the parallax needs less overscan than the same parallax alone', () => {
    const parallaxOnly = { offsetX: 0.06, offsetY: 0, zoom: 1, focus: 1 }
    expect(requiredZoom({ ...parallaxOnly, panX: 0.03 })).toBeLessThan(requiredZoom(parallaxOnly))
    expect(requiredZoom({ ...parallaxOnly, panX: -0.03 })).toBeGreaterThan(requiredZoom(parallaxOnly))
  })

  it('grows with intensity and with the distance of the focus from mid-depth', () => {
    expect(requiredOverscan(move('orbit-left', 1, 0.5))).toBeGreaterThan(
      requiredOverscan(move('orbit-left', 0.3, 0.5)),
    )
    expect(requiredOverscan(move('orbit-left', 1, 1))).toBeGreaterThan(
      requiredOverscan(move('orbit-left', 1, 0.5)),
    )
  })
})

describe('defaultCameraMove', () => {
  it('returns a usable move for every preset', () => {
    for (const preset of CAMERA_PRESETS) {
      const m = defaultCameraMove(preset)
      expect(m.preset).toBe(preset)
      expect(m.intensity).toBeGreaterThan(0)
      expect(m.intensity).toBeLessThanOrEqual(1)
      expect(m.focus).toBeGreaterThanOrEqual(0)
      expect(m.focus).toBeLessThanOrEqual(1)
    }
  })
})
