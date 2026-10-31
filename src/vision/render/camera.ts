import type { CameraMove, CameraPose, CameraPreset } from '../types.ts'

/**
 * Camera moves for the 2.5D parallax effect. Everything here is pure and deterministic, so preview and
 * export compute identical poses for the same move and progress.
 *
 * Conventions: offsets and pans are normalized image units (fraction of width / height), y points down.
 * A surface point at depth d appears displaced by `offset * (d - focus)`, so with a positive offsetX content
 * nearer than the focus plane shifts right and content behind it shifts left.
 */

export const CAMERA_PRESETS: readonly CameraPreset[] = [
  'dolly-in',
  'dolly-out',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'orbit-left',
  'orbit-right',
  'crane-up',
  'ken-burns',
]

/** Parallax offset at depth 1 (relative to the focus plane) at full intensity. */
const MAX_OFFSET = 0.06
const DEFAULT_INTENSITY = 0.5
const DEFAULT_FOCUS = 0.5
/** Every preset's largest required zoom falls on one of these evenly spaced progress values (see tests). */
const OVERSCAN_SAMPLES = 8
/** Keeps rounding in the shader's coordinate math from exposing a sub-pixel border. */
const OVERSCAN_MARGIN = 1.002

export function defaultCameraMove(preset: CameraPreset): CameraMove {
  return { preset, intensity: DEFAULT_INTENSITY, focus: DEFAULT_FOCUS }
}

/** Sine ease-in-out: zero velocity at both ends, so moves start and stop without a jolt. */
export function easeInOut(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t))
}

/** Pose of a move before the border-hiding overscan is applied (zoom is the preset's own zoom). */
function rawPose(move: CameraMove, progress: number): Required<CameraPose> {
  const intensity = clamp01(move.intensity)
  const focus = clamp01(move.focus)
  const e = easeInOut(progress)
  const s = 2 * e - 1
  const a = MAX_OFFSET * intensity
  const pose: Required<CameraPose> = { offsetX: 0, offsetY: 0, zoom: 1, focus, panX: 0, panY: 0, dolly: 0 }
  switch (move.preset) {
    case 'dolly-in':
    case 'dolly-out': {
      const k = move.preset === 'dolly-in' ? e : 1 - e
      // Dolly displacement grows towards the frame edges, so it is kept comparable to the pans' edge offsets.
      pose.zoom = 1 + 0.12 * intensity * k
      pose.dolly = 0.22 * intensity * k
      break
    }
    case 'pan-left':
    case 'pan-right': {
      // The camera trucks left, so the scene drifts right and near content moves faster than far content.
      const dir = move.preset === 'pan-left' ? 1 : -1
      pose.offsetX = dir * a * s
      pose.panX = dir * 0.5 * a * s
      break
    }
    case 'tilt-up':
    case 'tilt-down': {
      // Rotation produces little parallax, so a tilt is mostly a vertical drift.
      const dir = move.preset === 'tilt-up' ? 1 : -1
      pose.panY = dir * 0.8 * a * s
      pose.offsetY = dir * 0.35 * a * s
      break
    }
    case 'orbit-left':
    case 'orbit-right': {
      // The focus plane stays put while content in front and behind it swings in opposite directions.
      const dir = move.preset === 'orbit-left' ? 1 : -1
      pose.offsetX = dir * 1.3 * a * s
      pose.offsetY = -0.15 * a * Math.sin(Math.PI * e)
      pose.zoom = 1 + 0.04 * intensity * Math.sin(Math.PI * e)
      break
    }
    case 'crane-up':
      pose.offsetY = a * s
      pose.panY = 0.4 * a * s
      pose.zoom = 1 + 0.05 * intensity * e
      break
    case 'ken-burns':
      pose.zoom = 1 + 0.18 * intensity * e
      pose.dolly = 0.1 * intensity * e
      pose.offsetX = 0.5 * a * s
      pose.offsetY = 0.25 * a * s
      pose.panX = -0.3 * a * s
      pose.panY = -0.15 * a * s
      break
  }
  return pose
}

/**
 * Smallest zoom for which every sampled image coordinate stays inside the image, for any depth value.
 * Mirrors the renderer: `p = 0.5 + (uv - 0.5) / zoom - pan`, `q = p - (offset + (p - 0.5) * dolly) * (h - focus)`
 * with uv and h in [0, 1]. Per axis `q - 0.5 = a * (1 - dolly * k) - offset * k` with `a = (uv - 0.5) / zoom - pan`
 * and `k = h - focus` is bilinear, so the extremes are at uv in {0, 1} and k in {-focus, 1 - focus}; a pan
 * that counters the parallax therefore needs less overscan than one that adds to it.
 * Returns Infinity when no zoom can hide the borders.
 */
export function requiredZoom(pose: CameraPose): number {
  const dolly = pose.dolly ?? 0
  const layers = [-pose.focus, 1 - pose.focus]
  const axis = (offset: number, pan: number) => {
    let zoom = 1
    for (const k of layers) {
      const c = 1 - dolly * k
      const room = 0.5 - Math.abs(pan * c + offset * k)
      if (c <= 0 || room <= 0) return Infinity
      zoom = Math.max(zoom, (0.5 * c) / room)
    }
    return zoom
  }
  return Math.max(axis(pose.offsetX, pose.panX ?? 0), axis(pose.offsetY, pose.panY ?? 0))
}

/**
 * Constant zoom factor applied on top of the preset's own zoom for the whole move, so no pose shows a border.
 * Constant rather than per-pose, otherwise hiding borders would add an unintended zoom pulse to pans.
 */
export function requiredOverscan(move: CameraMove): number {
  let factor = 1
  for (let i = 0; i <= OVERSCAN_SAMPLES; i++) {
    const pose = rawPose(move, i / OVERSCAN_SAMPLES)
    factor = Math.max(factor, requiredZoom(pose) / pose.zoom)
  }
  return factor * OVERSCAN_MARGIN
}

/** Pose at `progress` (0..1 over the effect). Out-of-range or NaN inputs are clamped. */
export function cameraPoseAt(move: CameraMove, progress: number): CameraPose {
  const pose = rawPose(move, progress)
  pose.zoom *= requiredOverscan(move)
  return pose
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0
}
