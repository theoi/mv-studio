import type { Delegate, OnnxBackend, PersonModel, SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { createTrackReader } from '../mask/track.ts'
import { assessSuitability, type SuitabilityOptions } from '../mask/suitability.ts'
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
  suitability?: SuitabilityOptions
}

export interface PersonTrackResult {
  track: PackedMaskTrack
  suitability: SuitabilityReport
  /** Per-frame subject observations at the face detection rate, for auto-reframe. */
  observations: FrameObservation[]
  /** Frames where the high-quality matte replaced the standard mask. */
  hqFrames: number
}

/** Bumped whenever the processing changes in a way that invalidates cached tracks. */
export const PERSON_TRACK_VERSION = 1
const DEFAULT_MAX_SIDE = 512
const MODEL_OUTPUT_SIDE = 256

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
      const res = await seg.pushTrackFrame(
        { id, bitmap, timestampMs: Math.round(t * 1000), ...(hq ? { hq } : {}), faces: withFaces },
        { signal, transfer: hq ? [bitmap, hq.data.buffer] : [bitmap] },
      )
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
    return { track, suitability: trackSuitability(track, options.suitability), observations, hqFrames }
  } catch (err) {
    await seg.cancelTrack({ id }).catch(() => undefined)
    throw visionError(err, 'internal')
  }
}

/** Suitability of a stored track, judged on frames ~0.2 s apart (dense enough to measure stability). */
export function trackSuitability(track: PackedMaskTrack, options?: SuitabilityOptions): SuitabilityReport {
  const { meta } = track
  const step = Math.max(1, Math.round(meta.fps * 0.2))
  const reader = createTrackReader(track, 2)
  const samples = []
  for (let i = 0; i < meta.frameCount; i += step)
    samples.push({ t: meta.start + i / meta.fps, mask: reader.frame(i) })
  return assessSuitability(samples, step / meta.fps, options)
}
