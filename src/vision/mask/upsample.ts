import type { Mask, RgbaImage } from '../types.ts'

/**
 * Joint bilateral upsampling of a low-resolution soft mask, guided by the full-resolution
 * frame: mask values are interpolated from low-res neighbours weighted by spatial distance
 * and by colour similarity to the output pixel, so the cutout edge snaps to image edges.
 * This is the CPU reference; the compositor runs the same math in a shader
 * (`render/maskShader.ts`) with the same parameters.
 */
export interface UpsampleOptions {
  /** Neighbourhood radius in low-res pixels (window is 2·radius × 2·radius). */
  radius?: number
  /** Spatial sigma in low-res pixels. */
  sigmaSpatial?: number
  /** Colour sigma in 0..255 units (RGB distance per channel). */
  sigmaColor?: number
}

export const DEFAULT_UPSAMPLE: Required<UpsampleOptions> = { radius: 2, sigmaSpatial: 1.0, sigmaColor: 20 }

/** `guideLow` must be the frame resized to the mask size; `guideHigh` sets the output size. */
export function jointBilateralUpsample(
  low: Mask,
  guideLow: RgbaImage,
  guideHigh: RgbaImage,
  options: UpsampleOptions = {},
): Mask {
  const { radius, sigmaSpatial, sigmaColor } = { ...DEFAULT_UPSAMPLE, ...options }
  if (guideLow.width !== low.width || guideLow.height !== low.height)
    throw new Error('upsample: guideLow must match mask size')
  const { width: W, height: H } = guideHigh
  const { width: lw, height: lh } = low
  const out = new Uint8Array(W * H)
  const sx = lw / W
  const sy = lh / H
  const inv2s2 = 1 / (2 * sigmaSpatial * sigmaSpatial)
  const colorLut = new Float32Array(3 * 255 * 255 + 1)
  const inv2c2 = 1 / (2 * sigmaColor * sigmaColor * 3)
  for (let d = 0; d < colorLut.length; d++) colorLut[d] = Math.exp(-d * inv2c2)
  const gh = guideHigh.data
  const gl = guideLow.data
  const m = low.data
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) * sy - 0.5
    const vy0 = Math.floor(v) - radius + 1
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) * sx - 0.5
      const ux0 = Math.floor(u) - radius + 1
      const p = (y * W + x) * 4
      const r = gh[p]!
      const g = gh[p + 1]!
      const b = gh[p + 2]!
      let sum = 0
      let wsum = 0
      for (let qy = vy0; qy < vy0 + 2 * radius; qy++) {
        const cy = qy < 0 ? 0 : qy >= lh ? lh - 1 : qy
        const dy = qy - v
        for (let qx = ux0; qx < ux0 + 2 * radius; qx++) {
          const cx = qx < 0 ? 0 : qx >= lw ? lw - 1 : qx
          const dx = qx - u
          const q = cy * lw + cx
          const dr = r - gl[q * 4]!
          const dg = g - gl[q * 4 + 1]!
          const db = b - gl[q * 4 + 2]!
          const w = Math.exp(-(dx * dx + dy * dy) * inv2s2) * colorLut[dr * dr + dg * dg + db * db]!
          sum += m[q]! * w
          wsum += w
        }
      }
      out[y * W + x] =
        wsum > 1e-8
          ? Math.round(sum / wsum)
          : m[
              Math.min(lh - 1, Math.max(0, Math.round(v))) * lw + Math.min(lw - 1, Math.max(0, Math.round(u)))
            ]!
    }
  }
  return { width: W, height: H, data: out }
}

/** Area-average resize of RGBA pixels (exact for integer factors; used for guides). */
export function downsampleRgba(src: RgbaImage, width: number, height: number): RgbaImage {
  if (src.width === width && src.height === height) return src
  const out = new Uint8Array(width * height * 4)
  const { width: sw, height: sh, data } = src
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)) * 4
          r += data[p]!
          g += data[p + 1]!
          b += data[p + 2]!
          a += data[p + 3]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width, height, data: out }
}
