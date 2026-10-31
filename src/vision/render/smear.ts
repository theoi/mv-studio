import type { CameraMove, CameraPose, CameraPreset, GrayImage } from '../types.ts'
import { cameraPoseAt } from './camera.ts'
import { PARALLAX_MAX_STEPS, PARALLAX_MIN_STEPS } from './cameraEffect.ts'

/**
 * Predicts where a 3D camera move smears its still, before the move is added. Where the camera reveals background
 * that a foreground object covered, the ray march fills the gap by stretching the background next to the object's
 * edge. On a detailed background (a mountainside behind branches, trees behind a fence) that reads as streaks and
 * bent lines.
 */

/** Depth image as the renderer reads it: 0 far .. 255 near, row-major. */
export interface DepthField {
  width: number
  height: number
  data: Uint8Array
}

/** Local contrast of the still (luma standard deviation, 0..255), row-major. */
export interface ContrastMap {
  width: number
  height: number
  data: Float32Array
}

/** A still as the smear prediction sees it: the depth the effect uses, and the still's contrast. */
export interface SmearScene {
  depth: DepthField
  contrast: ContrastMap
}

/**
 * Largest share of the frame a move may smear and still count as clean. On the dev stills, moves below 0.3 % looked
 * clean and moves above 1 % showed streaked or bent background next to branches, fences and raised hands.
 */
export const SMEAR_LIMIT = 0.005
/** Stretch beyond the move's own zoom at which a pixel counts as smeared. */
const STRETCH = 2
/** Contrast (luma standard deviation) at which stretched background is fully visible. */
const DETAIL = 16
const GRID_COLUMNS = 160

export type ParallaxSampler = (u: number, v: number) => readonly [number, number]

/**
 * CPU copy of `parallaxMarch` (cameraEffect.ts) with the standalone renderer's geometry: for a pose, the function from
 * output point (u, v) to the image point the camera samples, both normalized with y down. The depth is read with the
 * GPU's LINEAR and CLAMP_TO_EDGE rules, so the result matches the shader up to float precision. The returned pair is
 * reused between calls.
 */
export function createParallaxSampler(depth: DepthField): (pose: CameraPose) => ParallaxSampler {
  const { width: w, height: h, data } = depth
  const read = (x: number, y: number): number => {
    const cx = (x > 0 ? (x < 1 ? x : 1) : 0) * w - 0.5
    const cy = (y > 0 ? (y < 1 ? y : 1) : 0) * h - 0.5
    const x0 = Math.floor(cx)
    const y0 = Math.floor(cy)
    const fx = cx - x0
    const fy = cy - y0
    const xa = x0 < 0 ? 0 : x0 > w - 1 ? w - 1 : x0
    const xb = x0 + 1 > w - 1 ? w - 1 : x0 + 1 < 0 ? 0 : x0 + 1
    const ya = (y0 < 0 ? 0 : y0 > h - 1 ? h - 1 : y0) * w
    const yb = (y0 + 1 > h - 1 ? h - 1 : y0 + 1 < 0 ? 0 : y0 + 1) * w
    const top = data[ya + xa]! + (data[ya + xb]! - data[ya + xa]!) * fx
    const bottom = data[yb + xa]! + (data[yb + xb]! - data[yb + xa]!) * fx
    return (top + (bottom - top) * fy) / 255
  }

  return (pose) => {
    const zoom = Math.max(1, pose.zoom)
    const panX = pose.panX ?? 0
    const panY = pose.panY ?? 0
    const dolly = pose.dolly ?? 0
    const focus = Math.min(1, Math.max(0, pose.focus))
    const out: [number, number] = [0, 0]
    return (u, v) => {
      const px = 0.5 + (u - 0.5) / zoom - panX
      const py = 0.5 + (v - 0.5) / zoom - panY
      const vx = pose.offsetX + (px - 0.5) * dolly
      const vy = pose.offsetY + (py - 0.5) * dolly
      const rayTexels = Math.ceil(Math.hypot(vx * w, vy * h))
      const steps = Math.min(PARALLAX_MAX_STEPS, Math.max(PARALLAX_MIN_STEPS, rayTexels))
      const dh = 1 / steps
      let layer = 1
      let d = read(px - vx * (layer - focus), py - vy * (layer - focus))
      let prevLayer = layer
      let prevD = d
      for (let i = 0; i < PARALLAX_MAX_STEPS; i++) {
        if (d >= layer || i >= steps) break
        prevLayer = layer
        prevD = d
        layer -= dh
        d = read(px - vx * (layer - focus), py - vy * (layer - focus))
      }
      let hit = layer
      const above = prevD - prevLayer
      const below = d - layer
      if (above < 0 && above - below < 0)
        hit = prevLayer + (layer - prevLayer) * Math.min(1, Math.max(0, above / (above - below)))
      out[0] = px - vx * (hit - focus)
      out[1] = py - vy * (hit - focus)
      return out
    }
  }
}

/** Luma standard deviation in a (2r+1)² window around each pixel. */
export function localContrast(gray: GrayImage, r = 2): ContrastMap {
  const { width: w, height: h, data } = gray
  const stride = w + 1
  const sum = new Float64Array(stride * (h + 1))
  const sq = new Float64Array(stride * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    let rowSq = 0
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!
      rowSum += v
      rowSq += v * v
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1]! + rowSum
      sq[(y + 1) * stride + x + 1] = sq[y * stride + x + 1]! + rowSq
    }
  }
  const box = (t: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    t[y1 * stride + x1]! - t[y0 * stride + x1]! - t[y1 * stride + x0]! + t[y0 * stride + x0]!
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const n = (y1 - y0) * (x1 - x0)
      const mean = box(sum, x0, y0, x1, y1) / n
      out[y * w + x] = Math.sqrt(Math.max(0, box(sq, x0, y0, x1, y1) / n - mean * mean))
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * Share of the frame (0..1) that a pose visibly smears. On a grid over the output, the warp's smallest local scale
 * (smallest singular value of its Jacobian, from finite differences) is compared with the pose's zoom: where it is
 * `STRETCH` times smaller, one source pixel covers that many output pixels in some direction. Each such pixel counts
 * by the contrast of the source it stretches, since stretched sky is invisible. Occlusion edges are jumps, not
 * stretches, and do not count.
 */
export function smearAt(
  sample: ParallaxSampler,
  zoom: number,
  contrast: ContrastMap,
  columns = GRID_COLUMNS,
): number {
  const rows = Math.max(1, Math.round((columns * contrast.height) / contrast.width))
  const stride = columns + 1
  const qx = new Float32Array(stride * (rows + 1))
  const qy = new Float32Array(stride * (rows + 1))
  for (let y = 0; y <= rows; y++)
    for (let x = 0; x <= columns; x++) {
      const q = sample(x / columns, y / rows)
      qx[y * stride + x] = q[0]
      qy[y * stride + x] = q[1]
    }
  const ref = 1 / Math.max(1, zoom)
  const { width: cw, height: ch, data: cd } = contrast
  let smear = 0
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const i = y * stride + x
      const a = (qx[i + 1]! - qx[i]!) * columns
      const c = (qy[i + 1]! - qy[i]!) * columns
      const b = (qx[i + stride]! - qx[i]!) * rows
      const d = (qy[i + stride]! - qy[i]!) * rows
      const t = a * a + b * b + c * c + d * d
      const det = a * d - b * c
      const smallest = Math.sqrt(Math.max(0, (t - Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2))
      if (smallest * STRETCH > ref) continue
      const sx = Math.min(cw - 1, Math.max(0, Math.floor(qx[i]! * cw)))
      const sy = Math.min(ch - 1, Math.max(0, Math.floor(qy[i]! * ch)))
      smear += Math.min(1, cd[sy * cw + sx]! / DETAIL)
    }
  return smear / (columns * rows)
}

/**
 * Share of the frame (0..1) the move smears at its worst moment. Every preset reaches its largest displacement at
 * the start or the end of the move, so those two poses decide (checked against five poses per move on the dev stills).
 */
export function smearOf(scene: SmearScene, move: CameraMove, columns = GRID_COLUMNS): number {
  const sampler = createParallaxSampler(scene.depth)
  let worst = 0
  for (const progress of [0, 1]) {
    const pose = cameraPoseAt(move, progress)
    worst = Math.max(worst, smearAt(sampler(pose), pose.zoom, scene.contrast, columns))
  }
  return worst
}

/**
 * Largest amount (0.05 to 1 in steps of 0.05) at which `preset` stays under `limit` on this still, or 0 when even
 * 0.05 smears. Smear grows with the amount, so this is a binary search.
 */
export function safeIntensity(
  scene: SmearScene,
  preset: CameraPreset,
  focus: number,
  limit = SMEAR_LIMIT,
): number {
  let lo = 0
  let hi = 20
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (smearOf(scene, { preset, intensity: mid / 20, focus }) <= limit) lo = mid
    else hi = mid - 1
  }
  return lo / 20
}
