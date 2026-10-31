import type { SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { estimateGlobalShift } from '../matching/motion.ts'
import { coverage, interiorPoints, iou, keepMajorComponents, shiftMask } from '../mask/ops.ts'
import { appendFrame, createPackedTrack } from '../mask/track.ts'
import { fitSize, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import { VISION_MODELS } from '../runtime/models.ts'
import type { GrayImage, Mask, PackedMaskTrack, Point, Size, TimeRange } from '../types.ts'

export interface SelectionTrackOptions extends TaskOptions {
  range?: TimeRange
  /** Mask frames per second, default 10 (the reader blends between them). */
  fps?: number
  /** Long side of the frames given to the selector and of the stored masks, default 512. */
  maxSide?: number
}

export interface SelectionTrackResult {
  track: PackedMaskTrack
  /** Fraction of frames where the object was confidently re-found. */
  trackedFraction: number
}

export interface SelectionDeps {
  segmentation: SegmentationBackend
  /** Small luma version of a frame for motion estimation; does not consume the bitmap. */
  toGray: (bitmap: ImageBitmap, size: Size) => GrayImage
}

export const SELECTION_TRACK_VERSION = 1
const GRAY_SIDE = 160
/** A re-segmented mask must overlap the motion-predicted one at least this much. */
const MIN_IOU = 0.3
const MAX_AREA_RATIO = 2.5
/** After this long without re-finding the object, the selection is dropped until the end. */
const MAX_LOST_SECONDS = 1

interface Step {
  mask: Mask
  gray: GrayImage
}

/**
 * Follows an object the user clicked at time `t` through the clip, forwards and backwards.
 * Each frame is re-prompted with points deep inside the previous mask after compensating
 * camera motion; results that disagree with that prediction are treated as lost.
 */
export async function buildSelectionTrack(
  deps: SelectionDeps,
  source: FrameSource,
  click: { t: number; points: Point[] },
  options: SelectionTrackOptions = {},
): Promise<SelectionTrackResult> {
  const { signal } = options
  if (!click.points.length)
    throw new JobError('invalid-input', 'At least one point is needed to select an object.')
  const range = options.range ?? { start: 0, end: source.duration }
  const fps = options.fps ?? 10
  const maxSide = options.maxSide ?? 512
  const maskSize = fitSize(source, maxSide)
  const graySize = fitSize(source, GRAY_SIDE)
  const t0 = Math.min(Math.max(click.t, range.start), Math.max(range.start, range.end - 1e-6))
  const before = Math.floor((t0 - range.start) * fps + 1e-9)
  const after = Math.max(0, Math.ceil((range.end - t0) * fps - 1e-9) - 1)
  const start = t0 - before / fps
  const total = before + after + 1
  const progress = createProgress(options.onProgress)
  const maxLost = Math.max(1, Math.round(MAX_LOST_SECONDS * fps))
  const seg = deps.segmentation

  const frame = (t: number) => source.frameAt(t, { maxSide })
  const select = async (bitmap: ImageBitmap, points: Point[]): Promise<Mask> => {
    const mask = await seg.select({ bitmap, points, maskSize }, { signal, transfer: [bitmap] })
    return keepMajorComponents(mask, 0.15)
  }

  try {
    progress(0, 'selecting')
    const masks = new Array<Mask | null>(total).fill(null)
    const lost = new Set<number>()
    const first = await frame(t0)
    const gray0 = deps.toGray(first, graySize)
    const mask0 = await select(first, click.points)
    if (coverage(mask0) === 0) throw new JobError('invalid-input', 'Nothing could be selected at that point.')
    masks[before] = mask0
    let done = 1
    progress(done / total, 'tracking')

    const follow = async (indices: number[]) => {
      let prev: Step = { mask: mask0, gray: gray0 }
      let lostRun = 0
      for (const index of indices) {
        if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
        if (lostRun >= maxLost) {
          masks[index] = {
            width: maskSize.width,
            height: maskSize.height,
            data: new Uint8Array(maskSize.width * maskSize.height),
          }
          lost.add(index)
        } else {
          const bitmap = await frame(start + index / fps)
          const gray = deps.toGray(bitmap, graySize)
          const { dx, dy } = estimateGlobalShift(prev.gray, gray)
          const predicted = shiftMask(
            prev.mask,
            Math.round((dx * maskSize.width) / graySize.width),
            Math.round((dy * maskSize.height) / graySize.height),
          )
          const points = interiorPoints(predicted, 3, 2)
          let accepted: Mask | null = null
          if (points.length) {
            const mask = await select(bitmap, points)
            const predictedArea = coverage(predicted)
            const ratio = predictedArea > 0 ? coverage(mask) / predictedArea : Infinity
            if (iou(mask, predicted) >= MIN_IOU && ratio <= MAX_AREA_RATIO && ratio >= 1 / MAX_AREA_RATIO)
              accepted = mask
          } else {
            bitmap.close()
          }
          if (accepted) {
            lostRun = 0
            masks[index] = accepted
            prev = { mask: accepted, gray }
          } else {
            lostRun++
            lost.add(index)
            masks[index] = predicted
            prev = { mask: predicted, gray }
          }
        }
        done++
        progress(done / total, 'tracking')
      }
    }
    await follow(Array.from({ length: after }, (_, k) => before + 1 + k))
    await follow(Array.from({ length: before }, (_, k) => before - 1 - k))

    const track = createPackedTrack({
      version: 1,
      kind: 'selection',
      mediaId: source.mediaId,
      sourceSize: { width: source.width, height: source.height },
      maskSize,
      fps,
      start,
      model: VISION_MODELS.magicTouch.name,
      quality: 'standard',
      lostFrames: [...lost].sort((a, b) => a - b),
    })
    for (const m of masks) appendFrame(track, m!, coverage(m!))
    progress(1, 'done')
    return { track, trackedFraction: (total - lost.size) / total }
  } catch (err) {
    throw visionError(err, 'internal')
  }
}
