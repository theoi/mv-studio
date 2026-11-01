import type { GrayImage, Mask, RgbaImage, Size } from '../types.ts'

type Drawable = ImageBitmap | OffscreenCanvas | HTMLVideoElement | HTMLImageElement | VideoFrame

function drawableSize(d: Drawable): Size {
  if ('videoWidth' in d) return { width: d.videoWidth, height: d.videoHeight }
  if ('displayWidth' in d) return { width: d.displayWidth, height: d.displayHeight }
  if ('naturalWidth' in d) return { width: d.naturalWidth, height: d.naturalHeight }
  return { width: d.width, height: d.height }
}

let scratch: OffscreenCanvas | null = null

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (!scratch) scratch = new OffscreenCanvas(width, height)
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width
    scratch.height = height
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas is unavailable')
  return ctx
}

/** Draws any frame into RGBA pixels at the given size (default: native size). */
export function toRgba(source: Drawable, size?: Size): RgbaImage {
  const { width, height } = size ?? drawableSize(source)
  const ctx = context(width, height)
  // drawImage composites, so a transparent frame would show the last frame drawn at this size.
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height)
  const img = ctx.getImageData(0, 0, width, height)
  return { width, height, data: img.data }
}

export function rgbaToGrayFast(rgba: RgbaImage): GrayImage {
  const n = rgba.width * rgba.height
  const out = new Uint8Array(n)
  const d = rgba.data
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (d[j]! * 77 + d[j + 1]! * 150 + d[j + 2]! * 29) >> 8
  return { width: rgba.width, height: rgba.height, data: out }
}

export function drawableSizeOf(source: Drawable): Size {
  return drawableSize(source)
}

/** Debug/evidence helper: mask as an opaque grayscale bitmap. */
export function maskToBitmap(mask: Mask): Promise<ImageBitmap> {
  const rgba = new Uint8ClampedArray(mask.width * mask.height * 4)
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i]!
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  return createImageBitmap(new ImageData(rgba, mask.width, mask.height))
}
