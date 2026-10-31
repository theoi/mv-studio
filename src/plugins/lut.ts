/**
 * 3D LUTs for the color grade: parses .cube files and Hald CLUT images and stores them as "strip" images, the layout
 * the color-grade shader samples. A size-N strip is N*N x N pixels: pixel (x, y) holds the output for input
 * r = x mod N, g = y, b = floor(x / N), each scaled to 0..1 by N - 1. Strips are ordinary image assets (origin
 * `{ type: 'derived', provider: 'lut' }`) referenced from the effect's `lut` param.
 */
import type { Asset } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'

export interface Lut3D {
  title?: string
  /** Entries per axis. */
  size: number
  /** Output RGB triplets with red changing fastest, then green, then blue. */
  data: Float32Array
}

/** Largest strip size: 64 * 64 = 4096 pixels wide, within every WebGL2 implementation's texture limit. */
export const MAX_STRIP_SIZE = 64
export const LUT_ORIGIN = { type: 'derived', provider: 'lut' } as const

const invalid = (message: string) => new JobError('invalid-input', message)

/** Parses an Adobe/Resolve .cube 3D LUT. Inputs outside the 0..1 domain are remapped into it. */
export function parseCubeLut(text: string): Lut3D {
  let size = 0
  let title: string | undefined
  let min = [0, 0, 0]
  let max = [1, 1, 1]
  const values: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const key = parts[0] as string
    if (/^[-+.\d]/.test(key)) {
      if (parts.length < 3) throw invalid(`Malformed LUT row "${line}"`)
      for (let i = 0; i < 3; i++) {
        const v = Number(parts[i])
        if (!Number.isFinite(v)) throw invalid(`Malformed LUT row "${line}"`)
        values.push(v)
      }
    } else if (key === 'TITLE') {
      title = line.slice(5).trim().replace(/^"|"$/g, '')
    } else if (key === 'LUT_3D_SIZE') {
      size = Number(parts[1])
    } else if (key === 'LUT_1D_SIZE') {
      throw invalid('This is a 1D LUT. Only 3D LUTs (LUT_3D_SIZE) are supported.')
    } else if (key === 'DOMAIN_MIN') {
      min = parts.slice(1, 4).map(Number)
    } else if (key === 'DOMAIN_MAX') {
      max = parts.slice(1, 4).map(Number)
    } else if (key === 'LUT_3D_INPUT_RANGE') {
      const [lo, hi] = parts.slice(1, 3).map(Number) as [number, number]
      min = [lo, lo, lo]
      max = [hi, hi, hi]
    }
  }
  if (!Number.isInteger(size) || size < 2 || size > 256) throw invalid('The file has no valid LUT_3D_SIZE.')
  if (values.length !== size ** 3 * 3)
    throw invalid(`Expected ${size ** 3} LUT rows for size ${size}, found ${values.length / 3}.`)
  if (min.some((v, i) => !Number.isFinite(v) || !((max[i] as number) > v)))
    throw invalid('Invalid LUT domain.')
  const lut: Lut3D = { title, size, data: Float32Array.from(values) }
  const identityDomain = min.every((v) => v === 0) && max.every((v) => v === 1)
  return identityDomain ? lut : remapDomain(lut, min, max)
}

/** Resamples a LUT defined over [min, max] so it covers inputs 0..1 (inputs outside the domain clamp to it). */
function remapDomain(lut: Lut3D, min: number[], max: number[]): Lut3D {
  const n = lut.size
  const data = new Float32Array(lut.data.length)
  const at = (i: number, c: number) =>
    (i / (n - 1) - (min[c] as number)) / ((max[c] as number) - (min[c] as number))
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++)
        data.set(sampleLut(lut, at(r, 0), at(g, 1), at(b, 2)), ((b * n + g) * n + r) * 3)
  return { ...lut, data }
}

/** Trilinear lookup; inputs are clamped to 0..1. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size
  const pos = [r, g, b].map((v) => Math.min(1, Math.max(0, v)) * (n - 1))
  const lo = pos.map((p) => Math.min(Math.floor(p), n - 2))
  const f = pos.map((p, i) => p - (lo[i] as number))
  const out: [number, number, number] = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const dr = corner & 1
    const dg = (corner >> 1) & 1
    const db = (corner >> 2) & 1
    const w =
      (dr ? (f[0] as number) : 1 - (f[0] as number)) *
      (dg ? (f[1] as number) : 1 - (f[1] as number)) *
      (db ? (f[2] as number) : 1 - (f[2] as number))
    if (w === 0) continue
    const i = ((((lo[2] as number) + db) * n + (lo[1] as number) + dg) * n + (lo[0] as number) + dr) * 3
    out[0] += w * (lut.data[i] as number)
    out[1] += w * (lut.data[i + 1] as number)
    out[2] += w * (lut.data[i + 2] as number)
  }
  return out
}

/** RGBA pixels of the strip image for a LUT, resampled to at most MAX_STRIP_SIZE entries per axis. */
export function lutToStrip(
  lut: Lut3D,
  size = Math.min(lut.size, MAX_STRIP_SIZE),
): {
  width: number
  height: number
  pixels: Uint8ClampedArray
} {
  const n = size
  const width = n * n
  const pixels = new Uint8ClampedArray(width * n * 4)
  const same = n === lut.size
  for (let g = 0; g < n; g++)
    for (let b = 0; b < n; b++)
      for (let r = 0; r < n; r++) {
        const rgb = same
          ? lut.data.subarray(((b * n + g) * n + r) * 3, ((b * n + g) * n + r) * 3 + 3)
          : sampleLut(lut, r / (n - 1), g / (n - 1), b / (n - 1))
        const o = (g * width + b * n + r) * 4
        pixels[o] = Math.round((rgb[0] as number) * 255)
        pixels[o + 1] = Math.round((rgb[1] as number) * 255)
        pixels[o + 2] = Math.round((rgb[2] as number) * 255)
        pixels[o + 3] = 255
      }
  return { width, height: n, pixels }
}

/**
 * Reads a Hald CLUT image (level L: a square image L^3 pixels wide holding an L^2-entry cube, red fastest) into a LUT.
 * Returns null for images of any other shape.
 */
export function haldToLut(pixels: Uint8ClampedArray, width: number, height: number): Lut3D | null {
  if (width !== height) return null
  const level = Math.round(Math.cbrt(width))
  if (level < 2 || level ** 3 !== width) return null
  const n = level * level
  const data = new Float32Array(n ** 3 * 3)
  for (let i = 0; i < n ** 3; i++) {
    data[i * 3] = (pixels[i * 4] as number) / 255
    data[i * 3 + 1] = (pixels[i * 4 + 1] as number) / 255
    data[i * 3 + 2] = (pixels[i * 4 + 2] as number) / 255
  }
  return { size: n, data }
}

/** Whether an asset is a LUT strip made by importLut (UIs list these as LUTs rather than media). */
export function isLutAsset(asset: Asset): boolean {
  return (
    asset.kind === 'image' && asset.origin.type === 'derived' && asset.origin.provider === LUT_ORIGIN.provider
  )
}

/** Whether a file is a .cube LUT, which Import media turns into a LUT rather than rejecting. */
export const isCubeFile = (file: File): boolean => /\.cube$/i.test(file.name)

async function readLut(file: Blob & { name?: string }): Promise<Lut3D> {
  if (/\.cube$/i.test(file.name ?? '') || file.type === 'text/plain' || file.type === '') {
    const text = await file.text()
    if (/LUT_(1D|3D)_SIZE/.test(text)) return parseCubeLut(text)
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  } catch (error) {
    throw new JobError('invalid-input', 'Choose a .cube file or a Hald CLUT image.', { cause: error })
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new JobError('unsupported', '2D canvas is not available')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const lut = haldToLut(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
  if (!lut)
    throw invalid('This image is not a Hald CLUT (a square image whose side is a cube number, like 512).')
  return lut
}

/** Converts a .cube file or Hald CLUT image into a LUT strip image asset, ready for the color grade's LUT param. */
export async function importLut(
  file: File,
  store: { storeBlob(blob: Blob, info: Pick<Asset, 'kind' | 'name' | 'origin'>): Promise<Asset> },
): Promise<Asset> {
  const lut = await readLut(file)
  const strip = lutToStrip(lut)
  const canvas = new OffscreenCanvas(strip.width, strip.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new JobError('unsupported', '2D canvas is not available')
  const image = ctx.createImageData(strip.width, strip.height)
  image.data.set(strip.pixels)
  ctx.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const name = lut.title ?? file.name.replace(/\.[^.]+$/, '')
  return store.storeBlob(blob, { kind: 'image', name, origin: { ...LUT_ORIGIN } })
}
