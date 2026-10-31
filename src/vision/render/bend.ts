import type { CameraMove, CameraPose, GrayImage } from '../types.ts'
import { cameraPoseAt } from './camera.ts'
import type { DepthField } from './smear.ts'

/**
 * Predicts where a 3D camera move bends the still's straight lines. The camera draws each point of the still
 * `zoom × (offset + (p − 0.5) × dolly) × (depth − focus)` away from where a flat camera would, so a straight line stays
 * straight only where the depth along it is even or changes steadily. Depth Anything gives each window of a facade
 * its own depth, and a move turns that into waves along a tower's edges and window rows. Nothing stretches there, so
 * the smear prediction (`smear.ts`) does not see it.
 */

/** A straight segment of the still, in pixels of the luma it was found in: from `from` to `to` along (dx, dy) from (x, y). */
export interface StraightLine {
  x: number
  y: number
  dx: number
  dy: number
  from: number
  to: number
}

export interface LineMap {
  width: number
  height: number
  lines: StraightLine[]
}

/** Shortest line, as a share of the image width (80 px at 1920): shorter edges do not read as straight lines. */
const LINE_MIN_LENGTH = 0.042
/** Weakest edge a line follows, as luma gradient per pixel. */
const LINE_MIN_GRADIENT = 12
/** Largest difference between a pixel's gradient direction and its line's. */
const LINE_ANGLE_TOLERANCE = Math.PI / 8

/**
 * The still's straight lines, from its luma (at the depth map's size): pixels on a strong edge are grown into regions
 * of one gradient direction, strongest first, and a region that is long and thin is a line.
 */
export function straightLines(gray: GrayImage): LineMap {
  const { width: w, height: h, data } = gray
  const minLength = LINE_MIN_LENGTH * w
  const mag = new Float32Array(w * h)
  const ang = new Float32Array(w * h)
  const byStrength: number[][] = Array.from({ length: 256 }, () => [])
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        (data[i - w + 1]! +
          2 * data[i + 1]! +
          data[i + w + 1]! -
          data[i - w - 1]! -
          2 * data[i - 1]! -
          data[i + w - 1]!) /
        8
      const gy =
        (data[i + w - 1]! +
          2 * data[i + w]! +
          data[i + w + 1]! -
          data[i - w - 1]! -
          2 * data[i - w]! -
          data[i - w + 1]!) /
        8
      const m = Math.hypot(gx, gy)
      mag[i] = m
      ang[i] = Math.atan2(gy, gx)
      if (m >= LINE_MIN_GRADIENT) byStrength[Math.min(255, Math.floor(m))]!.push(i)
    }
  const used = new Uint8Array(w * h)
  const lines: StraightLine[] = []
  const stack: number[] = []
  const region: number[] = []
  for (let level = 255; level >= 0; level--)
    for (const seed of byStrength[level]!) {
      if (used[seed]) continue
      used[seed] = 1
      stack.push(seed)
      region.length = 0
      let sx = Math.cos(ang[seed]!)
      let sy = Math.sin(ang[seed]!)
      let dir = ang[seed]!
      while (stack.length) {
        const i = stack.pop()!
        region.push(i)
        const x = i % w
        const y = (i - x) / w
        for (let ny = y - 1; ny <= y + 1; ny++)
          for (let nx = x - 1; nx <= x + 1; nx++) {
            if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
            const j = ny * w + nx
            if (used[j] || mag[j]! < LINE_MIN_GRADIENT) continue
            const turn = Math.abs(ang[j]! - dir)
            if (Math.min(turn, 2 * Math.PI - turn) > LINE_ANGLE_TOLERANCE) continue
            used[j] = 1
            stack.push(j)
            sx += Math.cos(ang[j]!)
            sy += Math.sin(ang[j]!)
            dir = Math.atan2(sy, sx)
          }
      }
      if (region.length >= minLength) {
        const line = fitLine(region, mag, w)
        if (line.to - line.from >= minLength) lines.push(line)
      }
    }
  return { width: w, height: h, lines }
}

/** The region's axis (weighted by edge strength), or a zero-length line when the region is too wide to be one. */
function fitLine(region: readonly number[], mag: Float32Array, w: number): StraightLine {
  let total = 0
  let mx = 0
  let my = 0
  for (const i of region) {
    const m = mag[i]!
    total += m
    mx += m * (i % w)
    my += m * Math.floor(i / w)
  }
  mx /= total
  my /= total
  let xx = 0
  let xy = 0
  let yy = 0
  for (const i of region) {
    const m = mag[i]!
    const dx = (i % w) - mx
    const dy = Math.floor(i / w) - my
    xx += m * dx * dx
    xy += m * dx * dy
    yy += m * dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy)
  const dx = Math.cos(theta)
  const dy = Math.sin(theta)
  let from = Infinity
  let to = -Infinity
  let near = Infinity
  let far = -Infinity
  for (const i of region) {
    const ox = (i % w) - mx
    const oy = Math.floor(i / w) - my
    const along = ox * dx + oy * dy
    const across = oy * dx - ox * dy
    from = Math.min(from, along)
    to = Math.max(to, along)
    near = Math.min(near, across)
    far = Math.max(far, across)
  }
  const thin = far - near <= Math.max(3, (to - from) / 12)
  return { x: mx, y: my, dx, dy, from, to: thin ? to : from }
}

/** A line counts as bent where it leaves its straight course by more than this, in pixels of a 1920-wide frame. */
export const BEND_PX = 3
/**
 * Largest length of bent line, as a share of the frame width, at which a move still counts as clean. On the dev
 * stills (35, 7 of them cityscapes), towers, planks and fence wires waved visibly from about 0.35, and around 0.2 the
 * waves were small.
 */
export const BEND_LIMIT = 0.25
/** Each line is judged in pieces this long (share of the width), so a gentle curve over a whole tower does not count. */
const PIECE = 0.1
/** Lines are read this far to each side (share of the width), off the edge itself. */
const SIDE = 0.0016
const STEP = 0.002
/** Mean depth difference across a line at which it is the outline of a nearer object, which only its near side moves. */
const OUTLINE = 0.04
/** A step this large between neighbouring points (px at 1920) is something in front crossing the line, not a bend. */
const CROSSING_PX = 4

/**
 * Share of the frame width (0..) of the still's straight lines that `pose` bends by more than `BEND_PX`. Each piece of
 * a line is read on both sides (only the near side of an outline), and its displacement across the line, less the
 * straight line that fits it best, is how far it bends.
 */
export function bendAt(pose: CameraPose, map: LineMap, depth: DepthField): number {
  const { width: w, height: h } = map
  const zoom = Math.max(1, pose.zoom)
  const panX = pose.panX ?? 0
  const panY = pose.panY ?? 0
  const dolly = pose.dolly ?? 0
  const focus = Math.min(1, Math.max(0, pose.focus))
  const piece = PIECE * w
  const side = SIDE * w
  const step = STEP * w
  const depthAt = depthReader(depth)
  const along: number[] = []
  const across: number[] = []
  let bent = 0
  for (const line of map.lines) {
    const nx = -line.dy
    const ny = line.dx
    for (let start = line.from; start < line.to - 4 * step; start += piece) {
      const end = Math.min(line.to, start + piece)
      let left = 0
      let right = 0
      let n = 0
      for (let k = start; k <= end; k += 2 * step) {
        const x = line.x + k * line.dx
        const y = line.y + k * line.dy
        left += depthAt((x - 3 * side * nx) / w, (y - 3 * side * ny) / h)
        right += depthAt((x + 3 * side * nx) / w, (y + 3 * side * ny) / h)
        n++
      }
      const sides = Math.abs(left - right) / n > OUTLINE ? [left > right ? -1 : 1] : [-1, 1]
      let worst = 0
      let length = 0
      for (const s of sides) {
        along.length = 0
        across.length = 0
        for (let k = start; k <= end; k += step) {
          const x = (line.x + k * line.dx + s * side * nx) / w
          const y = (line.y + k * line.dy + s * side * ny) / h
          const u = 0.5 + (x + panX - 0.5) * zoom
          const v = 0.5 + (y + panY - 0.5) * zoom
          if (u < 0 || u > 1 || v < 0 || v > 1) continue
          const d = depthAt(x, y) - focus
          const vx = pose.offsetX + (x - 0.5) * dolly
          const vy = pose.offsetY + (y - 0.5) * dolly
          across.push((vx * nx + vy * ny * (h / w)) * d * 1920 * zoom)
          along.push(k)
        }
        if (along.length < 6) continue
        let crossed = false
        for (let i = 1; i < across.length && !crossed; i++)
          crossed = Math.abs(across[i]! - across[i - 1]!) > CROSSING_PX
        if (crossed) continue
        worst = Math.max(worst, offLine(along, across))
        length = Math.max(length, along[along.length - 1]! - along[0]!)
      }
      if (worst > BEND_PX) bent += length
    }
  }
  return bent / w
}

/** Largest distance of the points (t, a) from their least-squares line. */
function offLine(t: readonly number[], a: readonly number[]): number {
  const n = t.length
  let mt = 0
  let ma = 0
  for (let i = 0; i < n; i++) {
    mt += t[i]!
    ma += a[i]!
  }
  mt /= n
  ma /= n
  let tt = 0
  let ta = 0
  for (let i = 0; i < n; i++) {
    tt += (t[i]! - mt) ** 2
    ta += (t[i]! - mt) * (a[i]! - ma)
  }
  const slope = tt ? ta / tt : 0
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[i]! - ma - slope * (t[i]! - mt)))
  return worst
}

/** Bilinear depth (0 far .. 1 near) at a normalized point, clamped to the edges like the GPU. */
function depthReader({ width: w, height: h, data }: DepthField): (x: number, y: number) => number {
  return (x, y) => {
    const cx = Math.min(1, Math.max(0, x)) * w - 0.5
    const cy = Math.min(1, Math.max(0, y)) * h - 0.5
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(cx)))
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(cy)))
    const x1 = Math.min(w - 1, x0 + 1)
    const y1 = Math.min(h - 1, y0 + 1)
    const fx = Math.min(1, Math.max(0, cx - x0))
    const fy = Math.min(1, Math.max(0, cy - y0))
    const top = data[y0 * w + x0]! + (data[y0 * w + x1]! - data[y0 * w + x0]!) * fx
    const bottom = data[y1 * w + x0]! + (data[y1 * w + x1]! - data[y1 * w + x0]!) * fx
    return (top + (bottom - top) * fy) / 255
  }
}

/** Share of the frame width the move bends at its worst moment (the start or the end, as for smear). */
export function bendOf(scene: { depth: DepthField; lines: LineMap }, move: CameraMove): number {
  let worst = 0
  for (const progress of [0, 1])
    worst = Math.max(worst, bendAt(cameraPoseAt(move, progress), scene.lines, scene.depth))
  return worst
}
