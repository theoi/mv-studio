import type { GrayImage, Mask } from '../types.ts'

/**
 * Live preview: causal, motion-aware exponential smoothing. Where the image barely changed,
 * mask changes are mostly model flicker and get smoothed heavily; where the image changed,
 * the mask follows the new prediction almost immediately, so moving subjects don't lag.
 */
export interface CausalSmootherOptions {
  /** Weight of the new mask where the image is static. */
  stillWeight?: number
  /** Weight of the new mask where the image changed by `motionScale` or more. */
  motionWeight?: number
  /** Luma difference (0..255) treated as full motion. */
  motionScale?: number
}

export interface CausalSmoother {
  push(mask: Mask, guide?: GrayImage): Mask
  reset(): void
}

export function createCausalSmoother(options: CausalSmootherOptions = {}): CausalSmoother {
  const still = options.stillWeight ?? 0.35
  const motion = options.motionWeight ?? 0.95
  const scale = options.motionScale ?? 20
  let state: Float32Array | null = null
  let prevGuide: Uint8Array | null = null
  let size = 0
  return {
    push(mask, guide) {
      const n = mask.data.length
      if (!state || size !== n) {
        state = Float32Array.from(mask.data)
        size = n
        prevGuide = guide && guide.data.length === n ? guide.data.slice() : null
        return { width: mask.width, height: mask.height, data: mask.data.slice() }
      }
      const out = new Uint8Array(n)
      const g = guide && guide.data.length === n ? guide.data : null
      for (let i = 0; i < n; i++) {
        let w = (still + motion) / 2
        if (g && prevGuide) {
          const m = Math.min(1, Math.abs(g[i]! - prevGuide[i]!) / scale)
          w = still + (motion - still) * m
        }
        const v = state[i]! + (mask.data[i]! - state[i]!) * w
        state[i] = v
        out[i] = Math.round(v)
      }
      prevGuide = g ? g.slice() : null
      return { width: mask.width, height: mask.height, data: out }
    },
    reset() {
      state = null
      prevGuide = null
    },
  }
}

/**
 * Export: zero-lag temporal joint-bilateral filter over a sliding window of 2·radius+1
 * frames. Each neighbour frame's mask contributes per pixel in proportion to its temporal
 * distance and how similar its guide pixel is to the current frame's, so flicker on static
 * areas averages out while moving edges stay sharp. Output is delayed by `radius` frames.
 */
export interface TemporalFilterOptions {
  radius?: number
  sigmaFrames?: number
  sigmaLuma?: number
}

export interface TemporalFilter {
  /** Returns the filtered mask for the frame pushed `radius` calls earlier, or null while filling. */
  push(mask: Mask, guide: GrayImage): Mask | null
  /** Filtered masks for the frames still in the window. */
  flush(): Mask[]
}

export function createTemporalFilter(options: TemporalFilterOptions = {}): TemporalFilter {
  const radius = Math.max(0, Math.round(options.radius ?? 2))
  const sigmaFrames = options.sigmaFrames ?? 1.2
  const sigmaLuma = options.sigmaLuma ?? 14
  const timeWeights = Array.from({ length: 2 * radius + 1 }, (_, k) =>
    Math.exp(-((k - radius) ** 2) / (2 * sigmaFrames ** 2)),
  )
  // Lookup for exp(-d²/2σ²) over luma differences 0..255.
  const lumaWeight = new Float32Array(256)
  for (let d = 0; d < 256; d++) lumaWeight[d] = Math.exp(-(d * d) / (2 * sigmaLuma * sigmaLuma))
  const window: Array<{ mask: Mask; guide: GrayImage }> = []
  let emitted = 0
  let pushed = 0

  const filterAt = (center: number): Mask => {
    const c = window[center]!
    const n = c.mask.data.length
    const out = new Uint8Array(n)
    const cg = c.guide.data
    for (let i = 0; i < n; i++) {
      let sum = 0
      let wsum = 0
      for (let j = 0; j < window.length; j++) {
        const f = window[j]!
        const k = j - center + radius
        if (k < 0 || k > 2 * radius) continue
        const w = timeWeights[k]! * lumaWeight[Math.abs(f.guide.data[i]! - cg[i]!)]!
        sum += f.mask.data[i]! * w
        wsum += w
      }
      out[i] = Math.round(sum / wsum)
    }
    return { width: c.mask.width, height: c.mask.height, data: out }
  }

  return {
    push(mask, guide) {
      if (guide.data.length !== mask.data.length)
        throw new Error('temporal filter: guide and mask sizes differ')
      window.push({ mask, guide })
      pushed++
      if (pushed <= radius) return null
      const center = window.length - 1 - radius
      const result = filterAt(center)
      emitted++
      if (window.length > 2 * radius + 1 || center >= radius) {
        while (window.length > 2 * radius) window.shift()
      }
      return result
    },
    flush() {
      const out: Mask[] = []
      while (emitted < pushed) {
        const center = window.length - (pushed - emitted)
        out.push(filterAt(center))
        emitted++
      }
      window.length = 0
      return out
    },
  }
}
