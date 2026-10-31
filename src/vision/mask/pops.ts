import type { GrayImage, Mask } from '../types.ts'

/**
 * A pop is part of the mask switching off and back on, or on and off, within this long on each side: the 2 to 4
 * frame dropouts and blobs that survive the track's temporal filter and show as flicker in the export.
 */
export const POP_GAP_SECONDS = 0.125
/**
 * A mask change counts only where the frame's luma (0–255) changes less than this over the same frames. Where the
 * picture changes as well, something really moved (an arm at the end of a swing), which is not flicker.
 */
export const POP_LUMA_TOLERANCE = 16

/** Frames on each side of a frame that a pop is looked for in, at `fps`. */
export function popGap(fps: number): number {
  return Math.max(1, Math.round(fps * POP_GAP_SECONDS))
}

/** Measures how much of the mask pops at each frame of a track, streaming, from its masks and frame luma. */
export interface PopMeter {
  /** Adds the next frame; returns the pop share of an earlier frame once the frames after it are in, else null. */
  push(mask: Mask, gray: GrayImage): number | null
  /** At the end of the track: the pop shares of the frames still waiting, in order. */
  flush(): number[]
}

interface HalfFrame {
  on: Uint8Array
  luma: Uint8Array
}

/** Half size (every second pixel of the mask, 2×2 luma averages), so a long track stays cheap to measure. */
function halve(mask: Mask, gray: GrayImage): HalfFrame {
  const w = mask.width >> 1
  const h = mask.height >> 1
  const on = new Uint8Array(w * h)
  const luma = new Uint8Array(w * h)
  const gw = gray.width
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      on[y * w + x] = mask.data[2 * y * mask.width + 2 * x]! >= 128 ? 1 : 0
      const g = 2 * y * gw + 2 * x
      luma[y * w + x] =
        (gray.data[g]! + gray.data[g + 1]! + gray.data[g + gw]! + gray.data[g + gw + 1]! + 2) >> 2
    }
  return { on, luma }
}

/**
 * Share of the subject (the pixels on in any of the frames compared) that pops at `center`, the largest over gaps of
 * 1 to `gaps` frames: on in the frames `k` before and after and off in between, or the reverse, where the luma stays
 * within `tolerance` across those frames.
 */
function popShare(frames: ReadonlyArray<HalfFrame>, center: number, gaps: number, tolerance: number): number {
  let best = 0
  const mid = frames[center]!
  for (let k = 1; k <= gaps; k++) {
    const a = frames[center - k]!
    const c = frames[center + k]!
    let flips = 0
    let area = 0
    for (let i = 0; i < mid.on.length; i++) {
      const x = a.on[i]!
      const y = mid.on[i]!
      const z = c.on[i]!
      if (x | y | z) area++
      if (x === z && x !== y) {
        const g = mid.luma[i]!
        if (Math.abs(g - a.luma[i]!) < tolerance && Math.abs(g - c.luma[i]!) < tolerance) flips++
      }
    }
    if (area) best = Math.max(best, flips / area)
  }
  return best
}

export function createPopMeter(fps: number, tolerance = POP_LUMA_TOLERANCE): PopMeter {
  const gap = popGap(fps)
  // The last 2 * gap + 1 frames; `first` is the index of window[0] in the track.
  const window: HalfFrame[] = []
  let first = 0
  let next = 0
  return {
    push(mask, gray) {
      if (gray.width !== mask.width || gray.height !== mask.height)
        throw new Error('pop meter: mask and luma sizes differ')
      window.push(halve(mask, gray))
      if (window.length > 2 * gap + 1) {
        window.shift()
        first++
      }
      const total = first + window.length
      // Frame `next` is ready once `gap` frames follow it (or fewer near the start, where fewer precede it).
      if (total - 1 - next < gap) return null
      const share = popShare(window, next - first, Math.min(gap, next), tolerance)
      next++
      return share
    },
    flush() {
      const out: number[] = []
      const total = first + window.length
      for (; next < total; next++) {
        const gaps = Math.min(gap, next, total - 1 - next)
        out.push(popShare(window, next - first, gaps, tolerance))
      }
      window.length = 0
      return out
    },
  }
}
