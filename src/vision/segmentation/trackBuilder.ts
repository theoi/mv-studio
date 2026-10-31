import type { GrayImage, Mask, MaskTrackMeta, PackedMaskTrack, Rect, RgbaImage } from '../types.ts'
import { fitSize } from '../runtime/frames.ts'
import { boundingBox, coverage, iou, resizeMask } from '../mask/ops.ts'
import { createTemporalFilter, type TemporalFilter, type TemporalFilterOptions } from '../mask/smoothing.ts'
import { createPopMeter } from '../mask/pops.ts'
import {
  detectedPeople,
  holdsLargeShape,
  keepPersonParts,
  peopleIndex,
  type PeopleAt,
} from '../mask/suitability.ts'
import { appendFrame, createPackedTrack } from '../mask/track.ts'
import { downsampleRgba, jointBilateralUpsample, type UpsampleOptions } from '../mask/upsample.ts'

/**
 * Keeps only the parts of each stored mask near the people the detector found (`keepPersonParts`), so an animal or a
 * patch of background the segmenter takes for a person stays out of the cutout. Times are seconds.
 */
export interface PersonGateConfig {
  /** How long boxes are held across detector misses (`peopleIndex`). */
  hold: number
  /** How long after the last frame with people a frame keeps the parts overlapping the previous kept mask. */
  carry: number
  /** How far ahead the detections can change a frame's people (`peopleIndexReach`): masks wait this long. */
  reach: number
  /**
   * The verdict judges every `judgeEvery`-th frame: of those, the ones the gate cuts down from a shape large enough for
   * the effect are noted (`meta.largeBeforeGate`).
   */
  judgeEvery: number
}

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
  /** Gate the stored masks to the people pushed with the frames (`TrackFrameInput.found`). */
  gate?: PersonGateConfig
}

interface Detection {
  box: Rect
  score: number
}

export interface TrackFrameInput {
  mask: Mask
  /** Frame luma; resized to the mask size if needed. */
  gray: GrayImage
  /** Frame pixels for edge refinement; resized to the mask size if needed. */
  rgba?: RgbaImage
  /**
   * What the person detector found in this frame, when it looked; null when it could not be loaded, which leaves every
   * mask of the track whole.
   */
  found?: { people?: ReadonlyArray<Detection>; animals?: ReadonlyArray<Detection> } | null
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
  /** Each stored mask's bounding box (null when empty), after `finish`. */
  boxes(): ReadonlyArray<Rect | null>
}

/**
 * Turns per-frame raw masks into a stored track: edge refinement, temporal filtering, gating to the people found
 * (`gate`), packing. A gated mask waits until the detections `gate.reach` seconds after it are in, so the stored masks,
 * their coverage and the pop meter run that far behind the pushed frames, and `finish` stores the rest.
 */
export function createMaskTrackBuilder(config: MaskTrackBuildConfig): MaskTrackBuilder {
  const track = createPackedTrack(config.meta)
  const { width, height } = config.meta.maskSize
  const { start, fps } = config.meta
  const lowSize =
    config.refineFrom && config.refineFrom < Math.max(width, height)
      ? fitSize({ width, height }, config.refineFrom)
      : null
  const filter: TemporalFilter | null =
    config.temporal === false ? null : createTemporalFilter(config.temporal ?? {})
  let finished = false
  const meter = config.pops ? createPopMeter(config.meta.fps) : null
  const pops: number[] = []
  const boxes: (Rect | null)[] = []
  // Frame luma waiting for its filtered mask, which the temporal filter emits a few frames later.
  const grays: GrayImage[] = []
  // Filtered masks waiting for the detections that decide what of them to keep.
  const waiting: { mask: Mask; gray: GrayImage | undefined }[] = []
  let gate = config.gate ?? null
  const people: PeopleAt[] = []
  // Rebuilt only when `people` changes: the animal vote makes it the gate's costliest part.
  let index: ((t: number) => Rect[]) | null = null
  let pushed = 0
  let stored = 0
  let carry: Mask | null = null
  const largeBeforeGate: number[] = []
  let lastWithPeople = -Infinity

  const append = (mask: Mask, gray: GrayImage | undefined) => {
    appendFrame(track, mask, coverage(mask))
    boxes.push(boundingBox(mask))
    if (!meter) return
    const share = meter.push(mask, gray!)
    if (share !== null) pops.push(share)
  }

  const gated = (mask: Mask, i: number, g: PersonGateConfig): Mask => {
    const t = start + i / fps
    while (people.length && people[0]!.t < t - g.reach) {
      people.shift()
      index = null
    }
    index ??= peopleIndex(people, g.hold)
    const near = index(t)
    if (near.length) lastWithPeople = t
    const kept = keepPersonParts(mask, near, near.length || t - lastWithPeople > g.carry ? null : carry)
    if (i % g.judgeEvery === 0 && kept !== mask && holdsLargeShape(mask)) largeBeforeGate.push(i)
    carry = kept
    return kept
  }

  /** Stores the waiting masks whose detections are all in (all of them when `all`). */
  const store = (all: boolean) => {
    const known = start + (pushed - 1) / fps
    while (waiting.length) {
      if (gate && !all && start + stored / fps + gate.reach > known) break
      const { mask, gray } = waiting.shift()!
      append(gate ? gated(mask, stored, gate) : mask, gray)
      stored++
    }
  }

  const filteredOut = (mask: Mask) => {
    waiting.push({ mask, gray: meter ? grays.shift()! : undefined })
  }

  return {
    push(frame) {
      if (finished) throw new Error('mask track builder: push after finish')
      if (frame.found === null) gate = null
      else if (frame.found && gate) {
        people.push(detectedPeople(start + pushed / fps, frame.found.people, frame.found.animals))
        index = null
      }
      pushed++
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
        if (out) filteredOut(out)
      } else {
        filteredOut(mask)
      }
      store(false)
      return stats
    },
    finish() {
      if (!finished) {
        if (filter) for (const m of filter.flush()) filteredOut(m)
        store(true)
        if (meter) {
          pops.push(...meter.flush())
          track.meta.pops = pops.map((p) => Math.round(p * 1000) / 1000)
        }
        if (largeBeforeGate.length) track.meta.largeBeforeGate = largeBeforeGate
      }
      finished = true
      return track
    },
    boxes: () => boxes,
  }
}
