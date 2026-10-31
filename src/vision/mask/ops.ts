import type { Mask, Point, Rect } from '../types.ts'

export function createMask(width: number, height: number, fill = 0): Mask {
  return { width, height, data: new Uint8Array(width * height).fill(fill) }
}

/** Float confidence (0..1) to an 8-bit mask. */
export function floatToMask(values: Float32Array, width: number, height: number): Mask {
  const data = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) {
    const v = values[i]!
    data[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }
  return { width, height, data }
}

/** Bilinear resize. */
export function resizeMask(mask: Mask, width: number, height: number): Mask {
  if (mask.width === width && mask.height === height) return { width, height, data: mask.data.slice() }
  const out = new Uint8Array(width * height)
  const { width: sw, height: sh, data } = mask
  const sx = sw / width
  const sy = sh / height
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const top = data[y0 * sw + x0]! * (1 - wx) + data[y0 * sw + x1]! * wx
      const bottom = data[y1 * sw + x0]! * (1 - wx) + data[y1 * sw + x1]! * wx
      out[y * width + x] = Math.round(top * (1 - wy) + bottom * wy)
    }
  }
  return { width, height, data: out }
}

/** Fraction of pixels at or above `threshold`. */
export function coverage(mask: Mask, threshold = 128): number {
  const d = mask.data
  let n = 0
  for (let i = 0; i < d.length; i++) if (d[i]! >= threshold) n++
  return d.length ? n / d.length : 0
}

export function iou(a: Mask, b: Mask, threshold = 128): number {
  if (a.data.length !== b.data.length) throw new Error('iou: masks differ in size')
  let inter = 0
  let union = 0
  for (let i = 0; i < a.data.length; i++) {
    const p = a.data[i]! >= threshold
    const q = b.data[i]! >= threshold
    if (p && q) inter++
    if (p || q) union++
  }
  return union === 0 ? 1 : inter / union
}

/** Mean absolute difference, 0..1. */
export function meanAbsDiff(a: Mask, b: Mask): number {
  let s = 0
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i]! - b.data[i]!)
  return a.data.length ? s / a.data.length / 255 : 0
}

/** Normalized bounding box of pixels >= threshold, or null if empty. */
export function boundingBox(mask: Mask, threshold = 128): Rect | null {
  const { width, height, data } = mask
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (data[row + x]! >= threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return {
    x: minX / width,
    y: minY / height,
    width: (maxX - minX + 1) / width,
    height: (maxY - minY + 1) / height,
  }
}

/** Confidence-weighted centroid in normalized coordinates, or null if empty. */
export function centroid(mask: Mask): Point | null {
  const { width, height, data } = mask
  let sx = 0
  let sy = 0
  let sw = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = data[y * width + x]!
      if (w) {
        sx += (x + 0.5) * w
        sy += (y + 0.5) * w
        sw += w
      }
    }
  }
  return sw ? { x: sx / sw / width, y: sy / sw / height } : null
}

export interface Component {
  /** Pixel count. */
  area: number
  /** Area as a fraction of the frame. */
  fraction: number
  box: Rect
}

/** 4-connected components of pixels >= threshold, largest first. Labels are returned for reuse. */
export function components(mask: Mask, threshold = 128): { components: Component[]; labels: Int32Array } {
  const { width, height, data } = mask
  const labels = new Int32Array(width * height).fill(-1)
  const stack = new Int32Array(width * height)
  const found: Component[] = []
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] !== -1 || data[start]! < threshold) continue
    const id = found.length
    let top = 0
    stack[top++] = start
    labels[start] = id
    let area = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    while (top > 0) {
      const p = stack[--top]!
      area++
      const x = p % width
      const y = (p - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // Inlined: a closure per pixel made this several times slower on 512 px track masks.
      if (x > 0 && labels[p - 1] === -1 && data[p - 1]! >= threshold) {
        labels[p - 1] = id
        stack[top++] = p - 1
      }
      if (x < width - 1 && labels[p + 1] === -1 && data[p + 1]! >= threshold) {
        labels[p + 1] = id
        stack[top++] = p + 1
      }
      if (y > 0 && labels[p - width] === -1 && data[p - width]! >= threshold) {
        labels[p - width] = id
        stack[top++] = p - width
      }
      if (y < height - 1 && labels[p + width] === -1 && data[p + width]! >= threshold) {
        labels[p + width] = id
        stack[top++] = p + width
      }
    }
    found.push({
      area,
      fraction: area / labels.length,
      box: {
        x: minX / width,
        y: minY / height,
        width: (maxX - minX + 1) / width,
        height: (maxY - minY + 1) / height,
      },
    })
  }
  const order = found.map((_, i) => i).sort((a, b) => found[b]!.area - found[a]!.area)
  const rank = new Int32Array(found.length)
  order.forEach((orig, r) => (rank[orig] = r))
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= 0) labels[i] = rank[labels[i]!]!
  return { components: order.map((i) => found[i]!), labels }
}

/** Keeps only components with at least `minFraction` of the largest component's area. */
export function keepMajorComponents(mask: Mask, minFraction = 0.08, threshold = 128): Mask {
  const { components: comps, labels } = components(mask, threshold)
  if (comps.length <= 1) return { width: mask.width, height: mask.height, data: mask.data.slice() }
  const minArea = comps[0]!.area * minFraction
  let keep = 0
  while (keep < comps.length && comps[keep]!.area >= minArea) keep++
  const out = mask.data.slice()
  for (let i = 0; i < out.length; i++) {
    const l = labels[i]!
    if (l >= keep) out[i] = 0
  }
  return { width: mask.width, height: mask.height, data: out }
}

/**
 * Chamfer (3-4) distance to the nearest background pixel, in pixels. Used to find
 * points deep inside a selection, which make robust prompts for re-segmenting.
 */
export function distanceInside(mask: Mask, threshold = 128): Float32Array {
  const { width: w, height: h, data } = mask
  const big = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = data[i]! >= threshold ? big : 0
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]!)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (d[i] === 0) continue
      d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (d[i] === 0) continue
      d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4)
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i]! / 3
  return d
}

/**
 * Up to `count` well-separated interior points (normalized), deepest first, each at least
 * `minDepth` pixels from the mask edge. Empty when the mask has no such pixels.
 */
export function interiorPoints(mask: Mask, count = 3, minDepth = 2, threshold = 128): Point[] {
  const dist = distanceInside(mask, threshold)
  const { width: w, height: h } = mask
  const picked: Array<{ x: number; y: number; d: number }> = []
  const candidates: number[] = []
  for (let i = 0; i < dist.length; i++) if (dist[i]! >= minDepth) candidates.push(i)
  candidates.sort((a, b) => dist[b]! - dist[a]!)
  for (const i of candidates) {
    if (picked.length >= count) break
    const x = i % w
    const y = (i - x) / w
    const d = dist[i]!
    const separation = Math.max(minDepth, picked[0] ? picked[0].d : d)
    if (picked.every((p) => Math.hypot(p.x - x, p.y - y) >= separation)) picked.push({ x, y, d })
  }
  return picked.map((p) => ({ x: (p.x + 0.5) / w, y: (p.y + 0.5) / h }))
}

/** Translates a mask by integer pixels, filling with 0. */
export function shiftMask(mask: Mask, dx: number, dy: number): Mask {
  const { width: w, height: h, data } = mask
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = y - dy
    if (sy < 0 || sy >= h) continue
    for (let x = 0; x < w; x++) {
      const sx = x - dx
      if (sx >= 0 && sx < w) out[y * w + x] = data[sy * w + sx]!
    }
  }
  return { width: w, height: h, data: out }
}
