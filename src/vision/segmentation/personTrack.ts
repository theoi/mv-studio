import type { Delegate, OnnxBackend, PersonModel, SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { resizeMask } from '../mask/ops.ts'
import { createPopMeter } from '../mask/pops.ts'
import { createTrackReader } from '../mask/track.ts'
import {
  CUTOUT_CARRY_SECONDS,
  CUTOUT_HOLD_SECONDS,
  assessSuitability,
  detectedPeople,
  peopleIndexReach,
  type PeopleAt,
  type SuitabilityOptions,
  type SuitabilitySample,
} from '../mask/suitability.ts'
import { fitSize, iterateFrames, prefetch, sampleTimes, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { FrameObservation } from '../reframe/track.ts'
import type { MaskQuality, PackedMaskTrack, Rect, SuitabilityReport, TimeRange } from '../types.ts'
import { VISION_MODELS } from '../runtime/models.ts'
import { createMaskTrackBuilder, type PersonGateConfig } from './trackBuilder.ts'

export interface PersonTrackOptions extends TaskOptions {
  range?: TimeRange
  /** Mask frames per second; default: the source frame rate, at most 30. */
  fps?: number
  /** Long side of the stored masks, default 512. The compositor upsamples them edge-aware. */
  maxSide?: number
  model?: PersonModel
  delegate?: Delegate
  /**
   * Ranges (typically where text overlaps the subject) that get a high-quality matte on top
   * of the standard mask. Needs an ONNX backend.
   */
  hqRanges?: TimeRange[]
  /** Processing short side for the high-quality matte, default 256. */
  hqShortSide?: number
  /** Face detection rate for subject tracking, default 5; 0 disables it. */
  faceFps?: number
  /** Rate of the person detection the report relies on, default `PEOPLE_FPS`. */
  peopleFps?: number
  /**
   * Criteria for the report. The cache key leaves them out, so a cached track keeps the report it was stored with;
   * only a report from older criteria (`SUITABILITY_VERSION`) is judged again with these.
   */
  suitability?: SuitabilityOptions
}

export interface PersonTrackResult {
  track: PackedMaskTrack
  suitability: SuitabilityReport
  /** Per-frame subject observations at the face detection rate, for auto-reframe. */
  observations: FrameObservation[]
  /** Frames where the high-quality matte replaced the standard mask. */
  hqFrames: number
  /**
   * People the object detector found, at `peopleFps`; the report counts only the mask near them. Empty when the
   * detector could not be downloaded (`suitability.peopleSkipped`).
   */
  people: PeopleAt[]
  /** Set when the face detector could not be downloaded, so the observations have no faces. */
  facesSkipped?: boolean
}

/**
 * Bumped whenever the processing changes in a way that invalidates cached tracks. 2: the masks keep only the parts near
 * the people found (`keepPersonParts`).
 */
export const PERSON_TRACK_VERSION = 2
const DEFAULT_MAX_SIDE = 512
const MODEL_OUTPUT_SIDE = 256
export const PEOPLE_FPS = 5

export function personTrackParams(
  source: Pick<FrameSource, 'width' | 'height' | 'frameRate' | 'duration'>,
  options: PersonTrackOptions,
) {
  const range = options.range ?? { start: 0, end: source.duration }
  const fps = options.fps ?? Math.min(30, source.frameRate > 0 ? source.frameRate : 30)
  const maskSize = fitSize(source, options.maxSide ?? DEFAULT_MAX_SIDE)
  const model = options.model ?? (source.width >= source.height ? 'selfieLandscape' : 'selfie')
  const quality: MaskQuality = options.hqRanges?.length ? 'high' : 'standard'
  return { range, fps, maskSize, model, quality }
}

/**
 * Segments the people in a clip into a stored mask track (export path): full clip at the
 * output frame rate, edge refinement against the frame, zero-lag temporal filtering, only the
 * parts near the people the detector finds (the whole mask when it cannot be loaded), and an
 * optional high-quality matte where text overlaps the subject.
 */
export async function buildPersonTrack(
  backends: { segmentation: SegmentationBackend; onnx?: OnnxBackend },
  source: FrameSource,
  options: PersonTrackOptions = {},
): Promise<PersonTrackResult> {
  const { signal } = options
  const { range, fps, maskSize, model, quality } = personTrackParams(source, options)
  const seg = backends.segmentation
  const hqRanges = options.hqRanges ?? []
  if (hqRanges.length && !backends.onnx)
    throw new JobError('unsupported', 'High-quality masks need the ONNX backend.')
  const times = sampleTimes(range.start, range.end, fps)
  if (!times.length) throw new JobError('invalid-input', 'The clip range is empty.')
  const progress = createProgress(options.onProgress)
  const faceEvery = options.faceFps === 0 ? 0 : Math.max(1, Math.round(fps / (options.faceFps ?? 5)))
  const peopleEvery = Math.max(1, Math.round(fps / (options.peopleFps ?? PEOPLE_FPS)))

  progress(0, 'loading-model')
  await seg.configure({ model, delegate: options.delegate ?? 'CPU' }, { signal })
  const { id } = await seg.beginTrack(
    {
      meta: {
        version: 1,
        kind: 'person',
        mediaId: source.mediaId,
        sourceSize: { width: source.width, height: source.height },
        maskSize,
        fps,
        start: times[0]!,
        model: VISION_MODELS[model].name + (quality === 'high' ? ' + MODNet' : ''),
        quality,
      },
      refineFrom: MODEL_OUTPUT_SIDE,
      temporal: {},
      pops: true,
      gate: personGate(fps, peopleEvery),
    },
    { signal },
  )

  // The person boxes and coverage come from the stored (gated) masks, once the track is finished.
  const observations: { i: number; t: number; faces: FrameObservation['faces'] }[] = []
  const people: PeopleAt[] = []
  let peopleAvailable = true
  let facesAvailable = true
  let hqFrames = 0
  try {
    let i = 0
    const frames = prefetch(
      iterateFrames(source, times, { maxSide: Math.max(maskSize.width, maskSize.height), signal }),
      2,
      (f) => f.bitmap.close(),
    )
    for await (const { t, bitmap } of frames) {
      let hq
      if (backends.onnx && hqRanges.some((r) => t >= r.start && t < r.end)) {
        const copy = await createImageBitmap(bitmap)
        hq = await backends.onnx.matte(
          { bitmap: copy, shortSide: options.hqShortSide ?? MODEL_OUTPUT_SIDE },
          { signal, transfer: [copy] },
        )
      }
      const observe = faceEvery > 0 && i % faceEvery === 0
      const withPeople = peopleAvailable && i % peopleEvery === 0
      const res = await seg.pushTrackFrame(
        {
          id,
          bitmap,
          timestampMs: Math.round(t * 1000),
          ...(hq ? { hq } : {}),
          faces: observe && facesAvailable,
          people: withPeople,
        },
        { signal, transfer: hq ? [bitmap, hq.data.buffer] : [bitmap] },
      )
      if (res.peopleUnavailable) peopleAvailable = false
      else if (withPeople) people.push(detectedPeople(t, res.people, res.animals))
      if (res.facesUnavailable) facesAvailable = false
      if (res.usedHq) hqFrames++
      if (observe) observations.push({ i, t, faces: res.faces ?? [] })
      i++
      progress(i / times.length, 'segmenting')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    if (i < times.length)
      throw new JobError('decode', `Only ${i} of ${times.length} frames could be decoded.`)
    const { track, boxes } = await seg.endTrack({ id }, { signal })
    progress(1, 'done')
    return {
      track,
      suitability: peopleAvailable
        ? trackSuitability(track, people, options.suitability)
        : { ...trackSuitability(track, undefined, options.suitability), peopleSkipped: true },
      observations: observationsOn(track, boxes, observations),
      hqFrames,
      people: peopleAvailable ? people : [],
      ...(facesAvailable ? {} : { facesSkipped: true }),
    }
  } catch (err) {
    await seg.cancelTrack({ id }).catch(() => undefined)
    throw visionError(err, 'internal')
  }
}

/** The cutout's gate (`keepPersonParts`) for a track at `fps` whose people are looked for every `peopleEvery` frames. */
function personGate(fps: number, peopleEvery: number): PersonGateConfig {
  return {
    hold: CUTOUT_HOLD_SECONDS,
    carry: CUTOUT_CARRY_SECONDS,
    reach: peopleIndexReach(CUTOUT_HOLD_SECONDS, peopleEvery / fps),
    judgeEvery: judgeStep(fps),
  }
}

/** The track's verdict judges every this many frames, about 0.2 s apart. */
function judgeStep(fps: number): number {
  return Math.max(1, Math.round(fps * 0.2))
}

/** Observations with the person box and coverage of the stored mask at their time. */
export function observationsOn(
  track: PackedMaskTrack,
  boxes: ReadonlyArray<Rect | null>,
  observations: ReadonlyArray<Pick<FrameObservation, 't' | 'faces'>>,
): FrameObservation[] {
  const { start, fps, coverage } = track.meta
  return observations.map(({ t, faces }) => {
    const i = Math.round((t - start) * fps)
    return { t, faces, personBox: boxes[i] ?? null, personCoverage: coverage[i] ?? 0 }
  })
}

/**
 * What the report needs that a track stored by an older version may lack: the people in its frames (at `peopleFps`)
 * and each frame's pop share, which needs every frame's luma. Needs only the person detector and the decoder, not the
 * segmenter. When the detector cannot be downloaded, `peopleSkipped` is set instead of `people`. With `gate` (masks
 * stored without the people, so whole), the masks are also cut down to the parts near the people found, as the build
 * does, into `gated` (with its pops and each mask's box); not when the detector cannot be downloaded.
 */
export async function findTrackEvidence(
  segmentation: SegmentationBackend,
  source: FrameSource,
  track: PackedMaskTrack,
  need: { people: boolean; pops: boolean; gate?: boolean },
  options: TaskOptions & { peopleFps?: number } = {},
): Promise<{
  people?: PeopleAt[]
  pops?: number[]
  peopleSkipped?: boolean
  gated?: { track: PackedMaskTrack; boxes: ReadonlyArray<Rect | null> }
}> {
  const { signal } = options
  const { meta } = track
  const every = Math.max(1, Math.round(meta.fps / (options.peopleFps ?? PEOPLE_FPS)))
  const { frameCount: _, coverage: __, pops: ___, largeBeforeGate: ____, ...base } = meta
  let builder =
    need.gate && need.people
      ? createMaskTrackBuilder({ meta: base, temporal: false, pops: true, gate: personGate(meta.fps, every) })
      : null
  const indices: number[] = []
  for (let i = 0; i < meta.frameCount; i += need.pops || builder ? 1 : every) indices.push(i)
  const progress = createProgress(options.onProgress)
  const people: PeopleAt[] = []
  let peopleAvailable = need.people
  const pops: number[] = []
  const meter = need.pops ? createPopMeter(meta.fps) : null
  const reader = createTrackReader(track, 2)
  const { width, height } = meta.maskSize
  try {
    const times = indices.map((i) => meta.start + i / meta.fps)
    const frames = prefetch(
      iterateFrames(source, times, { maxSide: Math.max(width, height), signal }),
      2,
      (f) => f.bitmap.close(),
    )
    let n = 0
    let stopped = false
    for await (const { t, bitmap } of frames) {
      const i = indices[n++]!
      const withPeople = peopleAvailable && i % every === 0
      const res = await segmentation.analyze(
        { bitmap, timestampMs: Math.round(t * 1000), people: withPeople, gray: !!meter || !!builder },
        { signal, transfer: [bitmap] },
      )
      if (res.peopleUnavailable) {
        peopleAvailable = false
        builder = null
        if (!meter) {
          stopped = true
          break
        }
      } else if (withPeople) people.push(detectedPeople(t, res.people, res.animals))
      if (meter || builder) {
        if (!res.gray) throw new JobError('internal', 'The frame luma is missing.')
        const gray =
          res.gray.width === width && res.gray.height === height
            ? res.gray
            : resizeMask(res.gray, width, height)
        const mask = reader.frame(i)
        const share = meter?.push(mask, gray) ?? null
        if (share !== null) pops.push(share)
        builder?.push({
          mask,
          gray,
          ...(withPeople ? { found: { people: res.people ?? [], animals: res.animals ?? [] } } : {}),
        })
      }
      progress(n / indices.length, 'analyzing')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    if (n < indices.length && !stopped)
      throw new JobError('decode', `Only ${n} of ${indices.length} frames could be decoded.`)
    if (meter) pops.push(...meter.flush())
    const gated = builder ? { track: builder.finish(), boxes: builder.boxes() } : null
    return {
      ...(need.people ? (peopleAvailable ? { people } : { peopleSkipped: true }) : {}),
      ...(meter ? { pops: pops.map((p) => Math.round(p * 1000) / 1000) } : {}),
      ...(gated ? { gated } : {}),
    }
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

/**
 * Suitability of a stored track, judged on frames about 0.2 s apart, counting only the mask near the `people` found
 * (the whole mask without them), with its stability from every frame's pop share (`meta.pops`, or `pops` for a
 * track stored without them). A frame with no one near whose mask the cutout cut down from a large shape
 * (`meta.largeBeforeGate`) says no person was found, as it would on the uncut mask.
 */
export function trackSuitability(
  track: PackedMaskTrack,
  people: ReadonlyArray<PeopleAt> | undefined,
  options?: SuitabilityOptions,
  pops = track.meta.pops,
): SuitabilityReport {
  const { meta } = track
  const step = judgeStep(meta.fps)
  const reader = createTrackReader(track, 1)
  const large = new Set(meta.largeBeforeGate)
  const samples: SuitabilitySample[] = []
  for (let i = 0; i < meta.frameCount; i += step)
    samples.push({
      t: meta.start + i / meta.fps,
      mask: reader.frame(i),
      ...(large.has(i) ? { largeBeforeGate: true } : {}),
    })
  return assessSuitability(
    samples,
    step / meta.fps,
    options,
    people,
    pops && { start: meta.start, fps: meta.fps, shares: pops },
  )
}
