/**
 * Contrast under lyrics: how bright the footage is under each text box, measured on the decoded frames the text
 * shows over, so lines over bright footage get a soft dark scrim whatever the look. Without a probe (no media access),
 * lines over footage keep only their dark outline and halo.
 */
import type { MediaFileSource } from '../engine/types.ts'
import type { Asset, Id, Project, Seconds } from '../model/types.ts'
import { createAssetFrameSource } from '../vision/index.ts'

/** A rectangle in normalized source coordinates, top-left origin. */
export interface SourceBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrightnessRequest {
  assetId: Id
  /** Source time of the frame (ignored for stills). */
  time: Seconds
  box: SourceBox
}

/** Mean luma (0..1) under each box, or undefined where the frame could not be read. */
export type BrightnessProbe = (requests: readonly BrightnessRequest[]) => Promise<(number | undefined)[]>

const SIDE = 128

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * A probe that decodes frames through src/vision's frame source (the export decoder) at 128 px, one decoder per clip
 * for the whole batch, in ascending time. A clip that fails to decode is left unmeasured.
 */
export function createBrightnessProbe(
  project: Pick<Project, 'assets'>,
  media: MediaFileSource,
): BrightnessProbe {
  return async (requests) => {
    const out: (number | undefined)[] = requests.map(() => undefined)
    const canvas = new OffscreenCanvas(SIDE, SIDE)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return out
    const measure = (bitmap: ImageBitmap, box: SourceBox) => {
      const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      canvas.width = w
      canvas.height = h
      ctx.drawImage(bitmap, 0, 0, w, h)
      const x0 = Math.min(w - 1, Math.floor(clamp01(box.x) * w))
      const y0 = Math.min(h - 1, Math.floor(clamp01(box.y) * h))
      const x1 = Math.max(x0 + 1, Math.ceil(clamp01(box.x + box.width) * w))
      const y1 = Math.max(y0 + 1, Math.ceil(clamp01(box.y + box.height) * h))
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4)
        sum +=
          0.2126 * (data[i] as number) + 0.7152 * (data[i + 1] as number) + 0.0722 * (data[i + 2] as number)
      return sum / (data.length / 4) / 255
    }
    const byAsset = new Map<Id, number[]>()
    requests.forEach((r, i) => byAsset.set(r.assetId, [...(byAsset.get(r.assetId) ?? []), i]))
    for (const [assetId, indices] of byAsset) {
      const asset: Asset | undefined = project.assets[assetId]
      try {
        if (asset?.kind === 'image') {
          const bitmap = await createImageBitmap(await media.getFile(asset))
          for (const i of indices) out[i] = measure(bitmap, (requests[i] as BrightnessRequest).box)
          bitmap.close()
        } else if (asset?.kind === 'video') {
          const source = createAssetFrameSource(asset, media)
          try {
            const last = Math.max(0, (asset.duration ?? 0) - 0.05)
            indices.sort(
              (a, b) => (requests[a] as BrightnessRequest).time - (requests[b] as BrightnessRequest).time,
            )
            for (const i of indices) {
              const r = requests[i] as BrightnessRequest
              const bitmap = await source.frameAt(Math.min(last, Math.max(0, r.time)), { maxSide: SIDE })
              out[i] = measure(bitmap, r.box)
              bitmap.close()
            }
          } finally {
            source.dispose()
          }
        }
      } catch {
        // Unreadable clips stay unmeasured; their lines keep the outline and halo.
      }
    }
    return out
  }
}
