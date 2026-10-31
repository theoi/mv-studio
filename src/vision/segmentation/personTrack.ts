import type { Delegate, OnnxBackend, PersonModel, SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { createTrackReader } from '../mask/track.ts'
import {
  assessSuitability,
  type PeopleAt,
  type SuitabilityOptions,
  type SuitabilitySample,
} from '../mask/suitability.ts'
import { fitSize, iterateFrames, prefetch, sampleTimes, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { FrameObservation } from '../reframe/track.ts'
import type { MaskQuality, PackedMaskTrack, SuitabilityReport, TimeRange } from '../types.ts'
import { VISION_MODELS } from '../runtime/models.ts'

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
  /** People the object detector found, at `peopleFps`; the report counts only the mask near them. */
  people: PeopleAt[]
}

/** Bumped whenever the processing changes in a way that invalidates cached tracks. */
export const PERSON_TRACK_VERSION = 1
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
 * output frame rate, edge refinement against the frame, zero-lag temporal filtering, and an
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
    },
    { signal },
  )

  const observations: FrameObservation[] = []
  const people: PeopleAt[] = []
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
      const withFaces = faceEvery > 0 && i % faceEvery === 0
      const withPeople = i % peopleEvery === 0
      const res = await seg.pushTrackFrame(
        {
          id,
          bitmap,
          timestampMs: Math.round(t * 1000),
          ...(hq ? { hq } : {}),
          faces: withFaces,
          people: withPeople,
        },
        { signal, transfer: hq ? [bitmap, hq.data.buffer] : [bitmap] },
      )
      if (withPeople) people.push({ t, boxes: (res.people ?? []).map((p) => p.box) })
      if (res.usedHq) hqFrames++
      if (withFaces)
        observations.push({ t, faces: res.faces ?? [], personBox: res.box, personCoverage: res.coverage })
      i++
      progress(i / times.length, 'segmenting')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    if (i < times.length)
      throw new JobError('decode', `Only ${i} of ${times.length} frames could be decoded.`)
    const track = await seg.endTrack({ id }, { signal })
    progress(1, 'done')
    return {
      track,
      suitability: trackSuitability(track, people, options.suitability),
      observations,
      hqFrames,
      people,
    }
  } catch (err) {
    await seg.cancelTrack({ id }).catch(() => undefined)
    throw visionError(err, 'internal')
  }
}

/**
 * Finds the people in the frames of a stored track at `peopleFps`, for a track stored before it kept them. Needs only
 * the person detector, not the segmenter.
 */
export async function findTrackPeople(
  segmentation: SegmentationBackend,
  source: FrameSource,
  meta: Pick<PackedMaskTrack['meta'], 'start' | 'fps' | 'frameCount'>,
  options: TaskOptions & { peopleFps?: number } = {},
): Promise<PeopleAt[]> {
  const { signal } = options
  const every = Math.max(1, Math.round(meta.fps / (options.peopleFps ?? PEOPLE_FPS)))
  const times: number[] = []
  for (let i = 0; i < meta.frameCount; i += every) times.push(meta.start + i / meta.fps)
  const progress = createProgress(options.onProgress)
  const people: PeopleAt[] = []
  try {
    const frames = prefetch(iterateFrames(source, times, { maxSide: DEFAULT_MAX_SIDE, signal }), 2, (f) =>
      f.bitmap.close(),
    )
    for await (const { t, bitmap } of frames) {
      const res = await segmentation.analyze(
        { bitmap, timestampMs: Math.round(t * 1000), people: true },
        { signal, transfer: [bitmap] },
      )
      people.push({ t, boxes: (res.people ?? []).map((p) => p.box) })
      progress(people.length / times.length, 'analyzing')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    return people
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

/**
 * Suitability of a stored track, judged on frames about 0.2 s apart, each with the frames just before and after it
 * for the flicker measure, and counting only the mask near the `people` found.
 */
export function trackSuitability(
  track: PackedMaskTrack,
  people: ReadonlyArray<PeopleAt>,
  options?: SuitabilityOptions,
): SuitabilityReport {
  const { meta } = track
  const step = Math.max(1, Math.round(meta.fps * 0.2))
  const reader = createTrackReader(track, 3)
  const samples: SuitabilitySample[] = []
  for (let i = 0; i < meta.frameCount; i += step) {
    const prev = i > 0 && i + 1 < meta.frameCount ? reader.frame(i - 1) : undefined
    const mask = reader.frame(i)
    const next = prev ? reader.frame(i + 1) : undefined
    samples.push({ t: meta.start + i / meta.fps, mask, ...(prev && next ? { prev, next } : {}) })
  }
  return assessSuitability(samples, step / meta.fps, options, people)
}
