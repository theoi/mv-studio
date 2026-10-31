import type { GrayImage, Mask, MaskTrackMeta, PackedMaskTrack, Rect, RgbaImage } from '../types.ts'
import { fitSize } from '../runtime/frames.ts'
import { boundingBox, coverage, iou, resizeMask } from '../mask/ops.ts'
import { createTemporalFilter, type TemporalFilter, type TemporalFilterOptions } from '../mask/smoothing.ts'
import { createPopMeter } from '../mask/pops.ts'
import { appendFrame, createPackedTrack } from '../mask/track.ts'
import { downsampleRgba, jointBilateralUpsample, type UpsampleOptions } from '../mask/upsample.ts'

export interface MaskTrackBuildConfig {
  meta: Omit<MaskTrackMeta, 'frameCount' | 'coverage'>
  /**
   * Long side of the segmentation model's native output. Masks are reduced to this size and
   * re-expanded with the frame as guide, so edges follow the image instead of the model's
   * coarse grid. 0 or >= the mask size disables refinement.
   */
  refineFrom?: number
  /** Zero-lag temporal joint-bilateral filtering; false disables it. */
  temporal?: TemporalFilterOptions | false
  upsample?: UpsampleOptions
  /** Measure the stored masks' pops per frame into `meta.pops` (person tracks). */
  pops?: boolean
}

export interface TrackFrameInput {
  mask: Mask
  /** Frame luma; resized to the mask size if needed. */
  gray: GrayImage
  /** Frame pixels for edge refinement; resized to the mask size if needed. */
  rgba?: RgbaImage
}

export interface TrackFrameStats {
  /** Of the refined mask, before temporal filtering. */
  coverage: number
  box: Rect | null
}

/** Below this agreement with the standard mask, a high-quality matte is assumed to have failed. */
export const HQ_MIN_IOU = 0.5

/**
 * Uses the high-quality matte only when it broadly agrees with the standard mask, so a
 * matting failure on an unusual shot (e.g. a wide shot for a portrait model) can't replace
 * a usable mask.
 */
export function preferHq(standard: Mask, hq: Mask, minIou = HQ_MIN_IOU): { mask: Mask; usedHq: boolean } {
  const resized = resizeMask(hq, standard.width, standard.height)
  return iou(resized, standard) >= minIou
    ? { mask: resized, usedHq: true }
    : { mask: standard, usedHq: false }
}

export interface MaskTrackBuilder {
  push(frame: TrackFrameInput): TrackFrameStats
  finish(): PackedMaskTrack
}

/** Turns per-frame raw masks into a stored track: edge refinement, temporal filtering, packing. */
export function createMaskTrackBuilder(config: MaskTrackBuildConfig): MaskTrackBuilder {
  const track = createPackedTrack(config.meta)
  const { width, height } = config.meta.maskSize
  const lowSize =
    config.refineFrom && config.refineFrom < Math.max(width, height)
      ? fitSize({ width, height }, config.refineFrom)
      : null
  const filter: TemporalFilter | null =
    config.temporal === false ? null : createTemporalFilter(config.temporal ?? {})
  let finished = false
  const meter = config.pops ? createPopMeter(config.meta.fps) : null
  const pops: number[] = []
  // Frame luma waiting for its filtered mask, which the temporal filter emits a few frames later.
  const grays: GrayImage[] = []

  const append = (mask: Mask) => {
    appendFrame(track, mask, coverage(mask))
    if (!meter) return
    const share = meter.push(mask, grays.shift()!)
    if (share !== null) pops.push(share)
  }

  return {
    push(frame) {
      if (finished) throw new Error('mask track builder: push after finish')
      let mask =
        frame.mask.width === width && frame.mask.height === height
          ? frame.mask
          : resizeMask(frame.mask, width, height)
      const rgba =
        frame.rgba && (frame.rgba.width !== width || frame.rgba.height !== height)
          ? downsampleRgba(frame.rgba, width, height)
          : frame.rgba
      if (lowSize && rgba) {
        const low = resizeMask(mask, lowSize.width, lowSize.height)
        mask = jointBilateralUpsample(
          low,
          downsampleRgba(rgba, lowSize.width, lowSize.height),
          rgba,
          config.upsample,
        )
      }
      const stats = { coverage: coverage(mask), box: boundingBox(mask) }
      const gray =
        (!filter && !meter) || (frame.gray.width === width && frame.gray.height === height)
          ? frame.gray
          : resizeMask(frame.gray, width, height)
      if (meter) grays.push(gray)
      if (filter) {
        const out = filter.push(mask, gray)
        if (out) append(out)
      } else {
        append(mask)
      }
      return stats
    },
    finish() {
      if (!finished) {
        if (filter) for (const m of filter.flush()) append(m)
        if (meter) {
          pops.push(...meter.flush())
          track.meta.pops = pops.map((p) => Math.round(p * 1000) / 1000)
        }
      }
      finished = true
      return track
    },
  }
}
