import type { SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { estimateSubpixelShift } from '../matching/motion.ts'
import {
  boundingBox,
  centroid,
  coverage,
  interiorPoints,
  keepMajorComponents,
  resizeMask,
  shiftMask,
} from '../mask/ops.ts'
import { appendFrame, createPackedTrack } from '../mask/track.ts'
import { rgbaToGrayFast } from '../runtime/canvas.ts'
import { fitSize, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import { VISION_MODELS } from '../runtime/models.ts'
import type { GrayImage, Mask, PackedMaskTrack, Point, RgbaImage, Size, TimeRange } from '../types.ts'
import {
  colorBins,
  colorHistogram,
  colorModel,
  likelihoodMap,
  adapted,
  meanInside,
  similarity,
  withDistractor,
  type ColorModel,
} from './appearance.ts'

/**
 * Per mask frame: `tracking` (found), `uncertain` (found, but partly hidden, just re-found or a weak match),
 * `lost` (expected in view but not found; the first few frames keep the predicted mask, then it is empty) and
 * `out-of-frame` (the camera or the object moved it out of the picture; empty mask).
 */
export type SelectionState = 'tracking' | 'uncertain' | 'lost' | 'out-of-frame'

export interface SelectionClick {
  t: number
  /** Positive points, normalized. One point is a click; several are treated as a scribble. */
  points: Point[]
}

export interface SelectionTrackOptions extends TaskOptions {
  range?: TimeRange
  /** Mask frames per second, default 10 (the reader blends between them). */
  fps?: number
  /** Long side of the frames given to the selector and of the stored masks, default 512. */
  maxSide?: number
  /**
   * More clicks on the same object at other times, e.g. where it was lost or the mask slipped onto something
   * else. Each one re-anchors the track: frames up to halfway to the neighbouring clicks follow from it, and
   * further where the neighbour lost the object.
   */
  corrections?: SelectionClick[]
}

export interface SelectionSpan {
  start: number
  end: number
  state: SelectionState
}

export interface SelectionTrackResult {
  track: PackedMaskTrack
  /** Fraction of frames where the object was found (tracking or uncertain). */
  trackedFraction: number
  /** State of every mask frame. */
  states: SelectionState[]
  /** 0..1 per mask frame: how well the mask matches the predicted position and the clicked object's colours. */
  confidence: number[]
  /** Runs of one state in media time, for a timeline strip; `end` is where the next run starts. */
  spans: SelectionSpan[]
  /** Starts of runs where the object was lost or stayed uncertain while expected in view: a click there helps. */
  needsCorrection: number[]
}

export interface SelectionDeps {
  segmentation: SegmentationBackend
  /** Small luma version of a frame for motion estimation; does not consume the bitmap. */
  toGray: (bitmap: ImageBitmap, size: Size) => GrayImage
  /** Small RGBA version of a frame for the colour model (used instead of `toGray` when given); does not consume. */
  toRgba?: (bitmap: ImageBitmap, size: Size) => RgbaImage
}

export const SELECTION_TRACK_VERSION = 2
const GRAY_SIDE = 160
/** A re-segmented mask must overlap the motion-predicted one at least this much. */
const MIN_IOU = 0.3
const MAX_AREA_RATIO = 2.5
/** Masks may not grow past this multiple of the largest recent full mask: that is merging into a neighbour. */
const MAX_GROWTH = 1.8
/** A re-found object should not be much larger than before it was lost: that is it together with a neighbour. */
const MAX_REFIND_GROWTH = 1.3
const AREA_MEMORY_SECONDS = 2
/** Below this fraction of the object predicted inside the picture, it has left the frame. */
const MIN_VISIBLE = 0.2
/** Lost frames that keep the predicted mask, so a short dropout does not flicker. */
const HOLD_SECONDS = 0.2
const VELOCITY_SMOOTHING = 0.3
/** Per lost frame, how much of the object's last speed is still assumed. */
const VELOCITY_DECAY = 0.9
/** Fraction of the frame width per mask frame. */
const MAX_SPEED = 0.03
/** Colour similarity (Bhattacharyya) to the clicked object below which a mask is something else. */
const MIN_SIMILARITY = 0.5
/** A mask whose similarity falls this far below the recent ones has slipped onto something else. */
const SIMILARITY_DROP = 0.3
/** A mask whose mean foreground score falls below this fraction of the recent ones has, too. */
const FOREGROUND_KEEP = 0.5
/** Stricter versions for re-finding a lost object. */
const REFIND_SIMILARITY_DROP = 0.15
const REFIND_FOREGROUND_KEEP = 0.7
/** Long enough that a few frames on the wrong object cannot lower the bar. */
const SIMILARITY_MEMORY_SECONDS = 2
const GOOD_SIMILARITY = 0.85
/** Overlap with the prediction above which a tracked mask is trusted to be the object whatever its colours. */
const PLACED_IOU = 0.6
/** How fast the colour model follows the object's changing look, per confidently tracked frame. */
const ADAPT_RATE = 0.1
/** Pixels whose colour scores below this fraction of the object's own mean are not prompted on. */
const FOCUS = 0.5
/** A lost object is looked for only where the colours score at least this fraction of the clicked frame's. */
const SEARCH_MIN = 0.6
const UNCERTAIN_BELOW = 0.35
const UNCERTAIN_SPAN_SECONDS = 0.5

interface FrameResult {
  mask: Mask
  state: SelectionState
  confidence: number
}

interface Observed {
  gray: GrayImage
  bins: Uint8Array | null
}

interface Anchor {
  index: number
  mask: Mask
  gray: GrayImage
  model: ColorModel | null
  /** Mean colour score over the object's bounding box at the anchor relative to the object's (search reference). */
  boxFill: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const found = (r: FrameResult | null | undefined) => r?.state === 'tracking' || r?.state === 'uncertain'

/** Summed-area table of a small float image, (w + 1) * (h + 1). */
function integral(values: Float32Array, w: number, h: number): Float64Array {
  const s = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += values[y * w + x]!
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1]! + row
    }
  }
  return s
}

/** Mean over the part of a box inside the image; -1 when less than half of it is inside. */
function boxMean(
  s: Float64Array,
  w: number,
  h: number,
  x: number,
  y: number,
  bw: number,
  bh: number,
): number {
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(w, x + bw)
  const y1 = Math.min(h, y + bh)
  const area = (x1 - x0) * (y1 - y0)
  if (x1 <= x0 || y1 <= y0 || area * 2 < bw * bh) return -1
  const W = w + 1
  return (s[y1 * W + x1]! - s[y0 * W + x1]! - s[y1 * W + x0]! + s[y0 * W + x0]!) / area
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Whether a mask reaches the border of the picture. */
function touchesEdge(m: Mask): boolean {
  const b = boundingBox(m)
  if (!b) return false
  const ex = 1.5 / m.width
  const ey = 1.5 / m.height
  return b.x <= ex || b.y <= ey || b.x + b.width >= 1 - ex || b.y + b.height >= 1 - ey
}

/** Pixels of `a` that are not in `b`. */
function without(a: Mask, b: Mask): Mask {
  const data = new Uint8Array(a.data.length)
  for (let i = 0; i < data.length; i++) if (a.data[i]! >= 128 && b.data[i]! < 128) data[i] = 255
  return { width: a.width, height: a.height, data }
}

/** Fraction of all pixels set in both masks. */
function overlap(a: Mask, b: Mask): number {
  let n = 0
  for (let i = 0; i < a.data.length; i++) if (a.data[i]! >= 128 && b.data[i]! >= 128) n++
  return a.data.length ? n / a.data.length : 0
}

/**
 * Follows an object the user clicked at time `t` (and at the times of any corrections) through the clip,
 * forwards and backwards. Each frame predicts where the object is from the camera motion and its own speed,
 * re-prompts the selector on points inside that prediction whose colours match the clicked object, and accepts
 * the result only if it agrees in place, size and colour. Lost objects are searched for near their predicted
 * position by colour, so they are re-found after an occlusion; objects predicted outside the picture are
 * reported out of frame instead of being replaced by whatever is at the edge.
 */
export async function buildSelectionTrack(
  deps: SelectionDeps,
  source: FrameSource,
  click: SelectionClick,
  options: SelectionTrackOptions = {},
): Promise<SelectionTrackResult> {
  const { signal } = options
  const clicks = [click, ...(options.corrections ?? [])]
  if (clicks.some((c) => !c.points.length))
    throw new JobError('invalid-input', 'At least one point is needed to select an object.')
  const range = options.range ?? { start: 0, end: source.duration }
  const fps = options.fps ?? 10
  const maxSide = options.maxSide ?? 512
  const maskSize = fitSize(source, maxSide)
  const graySize = fitSize(source, GRAY_SIDE)
  const { width: mw, height: mh } = maskSize
  const { width: gw, height: gh } = graySize
  const sx = mw / gw
  const sy = mh / gh
  const t0 = Math.min(Math.max(click.t, range.start), Math.max(range.start, range.end - 1e-6))
  const before = Math.floor((t0 - range.start) * fps + 1e-9)
  const after = Math.max(0, Math.ceil((range.end - t0) * fps - 1e-9) - 1)
  const start = t0 - before / fps
  const total = before + after + 1
  const timeAt = (i: number) => (i === before ? t0 : start + i / fps)
  const indexOf = (t: number) => Math.min(total - 1, Math.max(0, Math.round((t - start) * fps)))
  const progress = createProgress(options.onProgress)
  const holdFrames = Math.max(1, Math.round(HOLD_SECONDS * fps))
  const areaMemory = Math.max(2, Math.round(AREA_MEMORY_SECONDS * fps))
  const similarityMemory = Math.max(3, Math.round(SIMILARITY_MEMORY_SECONDS * fps))
  const maxSpeed = MAX_SPEED * mw
  const seg = deps.segmentation
  let done = 0
  const tick = () => progress(Math.min(0.99, ++done / total), 'tracking')

  const empty = (): Mask => ({ width: mw, height: mh, data: new Uint8Array(mw * mh) })
  const small = (m: Mask) => resizeMask(m, gw, gh)
  const cancelled = () => {
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
  }
  const observe = async (t: number): Promise<{ bitmap: ImageBitmap; obs: Observed }> => {
    const bitmap = await source.frameAt(t, { maxSide })
    try {
      const rgba = deps.toRgba?.(bitmap, graySize)
      const obs = rgba
        ? { gray: rgbaToGrayFast(rgba), bins: colorBins(rgba) }
        : { gray: deps.toGray(bitmap, graySize), bins: null }
      return { bitmap, obs }
    } catch (err) {
      bitmap.close()
      throw err
    }
  }
  const select = async (bitmap: ImageBitmap, points: Point[]): Promise<Mask> => {
    const mask = await seg.select({ bitmap, points, maskSize }, { signal, transfer: [bitmap] })
    return keepMajorComponents(mask, 0.15)
  }
  /** Pixels of `m` whose colour (sampled from the small likelihood map) scores at least `threshold`. */
  const focusMask = (m: Mask, like: Float32Array, threshold: number): Mask => {
    const out = new Uint8Array(mw * mh)
    for (let y = 0; y < mh; y++) {
      const row = Math.min(gh - 1, Math.floor(y / sy)) * gw
      for (let x = 0; x < mw; x++) {
        const i = y * mw + x
        if (m.data[i]! >= 128 && like[row + Math.min(gw - 1, Math.floor(x / sx))]! >= threshold) out[i] = 255
      }
    }
    return { width: mw, height: mh, data: out }
  }
  const boxOf = (m: Mask) => {
    const b = boundingBox(m)
    if (!b) return null
    return {
      x: Math.floor(b.x * gw),
      y: Math.floor(b.y * gh),
      w: Math.max(1, Math.round(b.width * gw)),
      h: Math.max(1, Math.round(b.height * gh)),
    }
  }

  /** Steps through consecutive frames in one direction from an anchor. */
  const follower = (anchor: Anchor) => {
    let model = anchor.model
    let ref = anchor.mask
    let refArea = coverage(ref)
    let refCenter = centroid(ref)!
    let offset = { x: 0, y: 0 }
    let camera = { x: 0, y: 0 }
    let velocity = { x: 0, y: 0 }
    let prevGray = anchor.gray
    let lostRun = 0
    let sinceRef = 0
    const areas = [refArea]
    const sims: number[] = []
    const fgs: number[] = []

    const learnDistractor = (bins: Uint8Array | null, region: Mask) => {
      const hist = bins && model ? colorHistogram(bins, small(region)) : null
      if (hist && model) model = withDistractor(model, hist)
    }

    /** Slides the predicted box to the most object-coloured spot nearby; null when nothing nearby looks right. */
    const searchNear = (motion: Mask, like: Float32Array): Mask | null => {
      const box = boxOf(motion)
      if (!box) return null
      const radius = Math.round(Math.max(box.w, box.h) * Math.min(2, 0.5 + 0.1 * lostRun))
      const sums = integral(like, gw, gh)
      let best = { dx: 0, dy: 0, score: -Infinity, mean: -1 }
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const mean = boxMean(sums, gw, gh, box.x + dx, box.y + dy, box.w, box.h)
          // Nearer spots win ties, so a static scene keeps the prediction.
          const score = mean - 0.002 * Math.hypot(dx, dy)
          if (mean >= 0 && score > best.score) best = { dx, dy, score, mean }
        }
      if (!model || best.mean < SEARCH_MIN * anchor.boxFill * model.self) return null
      return shiftMask(motion, Math.round(best.dx * sx), Math.round(best.dy * sy))
    }

    return async (index: number): Promise<FrameResult> => {
      cancelled()
      const { bitmap, obs } = await observe(timeAt(index))
      const shift = estimateSubpixelShift(prevGray, obs.gray)
      prevGray = obs.gray
      const keep = VELOCITY_DECAY ** lostRun
      camera = { x: camera.x + shift.dx * sx, y: camera.y + shift.dy * sy }
      offset = {
        x: offset.x + shift.dx * sx + velocity.x * keep,
        y: offset.y + shift.dy * sy + velocity.y * keep,
      }
      sinceRef++
      tick()
      const motion = shiftMask(ref, Math.round(offset.x), Math.round(offset.y))
      const recentArea = Math.max(...areas)
      const lose = (state: SelectionState): FrameResult => {
        lostRun++
        // Nobody knows where it went after leaving the picture; assume it stays put in the scene.
        if (state === 'out-of-frame') velocity = { x: 0, y: 0 }
        return { mask: state === 'lost' && lostRun <= holdFrames ? motion : empty(), state, confidence: 0 }
      }
      /** Not found: at the edge of the picture, mostly cut off, it has most likely left. */
      const missing = () =>
        lose(touchesEdge(motion) && coverage(motion) < 0.5 * recentArea ? 'out-of-frame' : 'lost')
      if (coverage(motion) < MIN_VISIBLE * refArea) {
        bitmap.close()
        return lose('out-of-frame')
      }
      const like = model && obs.bins ? likelihoodMap(obs.bins, model) : null
      const predicted = lostRun > 0 && like ? searchNear(motion, like) : motion
      if (!predicted) {
        bitmap.close()
        return missing()
      }
      let points = interiorPoints(predicted, 3, 2)
      if (like && model) {
        // Points deep inside the prediction unless some land on colours the object does not have (something in
        // front of it, or the neighbour it is drifting onto): then only points on the object's colours.
        const threshold = FOCUS * model.self
        const onObject = (p: Point) =>
          like[Math.min(gh - 1, Math.floor(p.y * gh)) * gw + Math.min(gw - 1, Math.floor(p.x * gw))]! >=
          threshold
        if (!points.every(onObject)) {
          const focus = focusMask(predicted, like, threshold)
          points = coverage(focus) >= 0.1 * coverage(predicted) ? interiorPoints(focus, 3, 2) : []
        }
      }
      if (!points.length) {
        bitmap.close()
        return missing()
      }
      const candidate = await select(bitmap, points)
      const area = coverage(candidate)
      const predictedArea = coverage(predicted)
      const inter = overlap(candidate, predicted)
      const fit = area ? inter / (area + predictedArea - inter) : 0
      const precision = area ? inter / area : 0
      const recall = inter / predictedArea
      const ratio = area / predictedArea
      const growth = area / recentArea
      const low = area ? small(candidate) : null
      const hist = obs.bins && model && low ? colorHistogram(obs.bins, low) : null
      const sim = hist && model ? similarity(hist, model.target) : null
      const fg = like && model && low ? meanInside(like, low) / model.self : null
      // Re-finding a lost object needs it to look like it did before it was lost; tracking allows drift.
      const strict = lostRun > 0
      const simFloor = sims.length
        ? Math.max(MIN_SIMILARITY, median(sims) - (strict ? REFIND_SIMILARITY_DROP : SIMILARITY_DROP))
        : MIN_SIMILARITY
      const fgFloor = fgs.length ? median(fgs) * (strict ? REFIND_FOREGROUND_KEEP : FOREGROUND_KEEP) : 0
      if (!area) return missing()
      if (growth > (strict ? MAX_REFIND_GROWTH : MAX_GROWTH)) {
        learnDistractor(obs.bins, without(candidate, predicted))
        return missing()
      }
      // While tracking, a mask right where the object was predicted is kept even if its colours drift (it turns,
      // comes closer, lets go of what it carried); colours decide only when the shapes do not.
      const placed = !strict && fit >= PLACED_IOU
      if (sim !== null && (sim < MIN_SIMILARITY || (!placed && sim < simFloor))) return missing()
      if (fg !== null && !placed && fg < fgFloor) return missing()
      const colour = sim === null ? 1 : clamp01((sim - MIN_SIMILARITY) / (GOOD_SIMILARITY - MIN_SIMILARITY))
      let confidence: number
      let full: boolean
      if (fit >= MIN_IOU && ratio <= MAX_AREA_RATIO && ratio >= 1 / MAX_AREA_RATIO) {
        confidence = clamp01((fit - MIN_IOU) / 0.4) * colour
        full = true
      } else if (sim !== null && !strict && precision >= 0.7 && ratio >= 0.15) {
        // Partly hidden: a smaller mask inside the predicted one with the object's colours.
        confidence = Math.min(UNCERTAIN_BELOW / 2, colour)
        full = false
      } else if (sim !== null && strict && Math.max(precision, recall) >= 0.5 && growth >= 0.25) {
        // Re-found near where the search expected it.
        confidence = Math.min(UNCERTAIN_BELOW / 2, colour)
        full = growth >= 0.6
      } else {
        return missing()
      }
      if (strict) confidence = Math.min(confidence, UNCERTAIN_BELOW / 2)
      const center = centroid(candidate)!
      if (full && !strict && sinceRef === 1 && !touchesEdge(candidate)) {
        const ux = (center.x - refCenter.x) * mw - camera.x
        const uy = (center.y - refCenter.y) * mh - camera.y
        const vx = velocity.x + VELOCITY_SMOOTHING * (ux - velocity.x)
        const vy = velocity.y + VELOCITY_SMOOTHING * (uy - velocity.y)
        const speed = Math.hypot(vx, vy)
        const k = speed > maxSpeed ? maxSpeed / speed : 1
        velocity = { x: vx * k, y: vy * k }
      } else if (!full) {
        velocity = { x: velocity.x * keep, y: velocity.y * keep }
      }
      if (full) {
        areas.push(area)
        if (areas.length > areaMemory) areas.shift()
        if (sim !== null) {
          sims.push(sim)
          if (sims.length > similarityMemory) sims.shift()
        }
        if (fg !== null) {
          fgs.push(fg)
          if (fgs.length > similarityMemory) fgs.shift()
        }
        if (hist && model && placed) model = adapted(model, hist, ADAPT_RATE)
      }
      ref = candidate
      refArea = area
      refCenter = center
      offset = { x: 0, y: 0 }
      camera = { x: 0, y: 0 }
      sinceRef = 0
      lostRun = 0
      return { mask: candidate, state: confidence >= UNCERTAIN_BELOW ? 'tracking' : 'uncertain', confidence }
    }
  }
  try {
    progress(0, 'selecting')
    const byIndex = new Map<number, SelectionClick>()
    for (const c of clicks) byIndex.set(indexOf(c.t), c)
    const anchors: Anchor[] = []
    for (const [index, c] of [...byIndex].sort((a, b) => a[0] - b[0])) {
      cancelled()
      const { bitmap, obs } = await observe(timeAt(index))
      const mask = await select(bitmap, c.points)
      if (coverage(mask) === 0)
        throw new JobError('invalid-input', 'Nothing could be selected at that point.')
      const model = obs.bins ? colorModel(obs.bins, small(mask)) : null
      const box = boxOf(mask)!
      const boxFill =
        model && obs.bins
          ? boxMean(integral(likelihoodMap(obs.bins, model), gw, gh), gw, gh, box.x, box.y, box.w, box.h) /
            model.self
          : 0
      anchors.push({ index, mask, gray: obs.gray, model, boxFill })
      tick()
    }

    const results = new Array<FrameResult | null>(total).fill(null)
    for (const a of anchors) results[a.index] = { mask: a.mask, state: 'tracking', confidence: 1 }
    const first = anchors[0]!
    const last = anchors[anchors.length - 1]!
    const ahead = follower(last)
    for (let i = last.index + 1; i < total; i++) results[i] = await ahead(i)
    const behind = follower(first)
    for (let i = first.index - 1; i >= 0; i--) results[i] = await behind(i)
    // Between two clicks each follows to the midpoint, then on through frames where the other lost the object.
    for (let k = 0; k + 1 < anchors.length; k++) {
      const a = anchors[k]!
      const b = anchors[k + 1]!
      const mid = Math.floor((a.index + b.index) / 2)
      const fwd = follower(a)
      const back = follower(b)
      for (let i = a.index + 1; i <= mid; i++) results[i] = await fwd(i)
      for (let i = b.index - 1; i > mid; i--) results[i] = await back(i)
      for (let i = mid + 1; i < b.index && !found(results[i]); i++) {
        const r = await fwd(i)
        if (found(r)) results[i] = r
      }
      for (let i = mid; i > a.index && !found(results[i]); i--) {
        const r = await back(i)
        if (found(r)) results[i] = r
      }
    }

    const states = results.map((r) => r!.state)
    const lostFrames = states.flatMap((s, i) => (s === 'lost' || s === 'out-of-frame' ? [i] : []))
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
      lostFrames,
    })
    for (const r of results) appendFrame(track, r!.mask, coverage(r!.mask))
    progress(1, 'done')
    return selectionResult(
      track,
      states,
      results.map((r) => +r!.confidence.toFixed(3)),
    )
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

/** The full result from a track and its per-frame states (also used to restore cached results). */
export function selectionResult(
  track: PackedMaskTrack,
  states: SelectionState[],
  confidence: number[],
): SelectionTrackResult {
  const { fps, start } = track.meta
  const spans: SelectionSpan[] = []
  states.forEach((state, i) => {
    const t = +(start + i / fps).toFixed(3)
    const end = +(start + (i + 1) / fps).toFixed(3)
    const prev = spans[spans.length - 1]
    if (prev?.state === state) prev.end = end
    else spans.push({ start: t, end, state })
  })
  const needsCorrection = spans
    .filter(
      (s) => s.state === 'lost' || (s.state === 'uncertain' && s.end - s.start >= UNCERTAIN_SPAN_SECONDS),
    )
    .map((s) => s.start)
  const foundFrames = states.filter((s) => s === 'tracking' || s === 'uncertain').length
  return {
    track,
    trackedFraction: states.length ? foundFrames / states.length : 0,
    states,
    confidence,
    spans,
    needsCorrection,
  }
}

/** State of the mask frame nearest to media time `t`. */
export function selectionStateAt(result: SelectionTrackResult, t: number): SelectionState {
  const { fps, start, frameCount } = result.track.meta
  const i = Math.min(frameCount - 1, Math.max(0, Math.round((t - start) * fps)))
  return result.states[i] ?? 'lost'
}
