import type { SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { boundingBox, coverage, keepMajorComponents } from '../mask/ops.ts'
import { iterateFrames, prefetch, sampleTimes, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { ReframeAspect, ReframePlan, SubjectTrack, TimeRange } from '../types.ts'
import { planReframe, type ReframeOptions } from './planner.ts'
import { buildSubjectTrack, smoothSubjectTrack, type FrameObservation } from './track.ts'

export interface SubjectAnalysisOptions extends TaskOptions {
  range?: TimeRange
  /** Samples per second, default 5. */
  fps?: number
  /** Long side of analysed frames, default 384. */
  maxSide?: number
}

export const SUBJECT_TRACK_VERSION = 1

/** Where the people (faces first, else person masks) are over a clip, for auto-reframe. */
export async function analyzeSubjects(
  segmentation: SegmentationBackend,
  source: FrameSource,
  options: SubjectAnalysisOptions = {},
): Promise<SubjectTrack> {
  const { signal } = options
  const range = options.range ?? { start: 0, end: source.duration }
  const times = sampleTimes(range.start, range.end, options.fps ?? 5)
  if (!times.length) throw new JobError('invalid-input', 'The clip range is empty.')
  const progress = createProgress(options.onProgress)
  try {
    progress(0, 'loading-model')
    await segmentation.configure(
      { model: source.width >= source.height ? 'selfieLandscape' : 'selfie', delegate: 'CPU' },
      { signal },
    )
    await segmentation.resetStream(null, { signal })
    const observations: FrameObservation[] = []
    const frames = prefetch(
      iterateFrames(source, times, { maxSide: options.maxSide ?? 384, signal }),
      2,
      (f) => f.bitmap.close(),
    )
    for await (const { t, bitmap } of frames) {
      const res = await segmentation.analyze(
        { bitmap, timestampMs: Math.round(t * 1000), mask: true, faces: true },
        { signal, transfer: [bitmap] },
      )
      const mask = res.mask ? keepMajorComponents(res.mask) : null
      observations.push({
        t,
        faces: res.faces ?? [],
        personBox: mask ? boundingBox(mask) : null,
        personCoverage: mask ? coverage(mask) : 0,
      })
      progress(observations.length / times.length, 'analyzing')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    return subjectTrackFrom(source, observations)
  } catch (err) {
    throw visionError(err, 'internal')
  }
}

/** Smoothed subject track from observations (e.g. those collected while building a person mask track). */
export function subjectTrackFrom(
  source: Pick<FrameSource, 'mediaId' | 'width' | 'height'>,
  observations: FrameObservation[],
): SubjectTrack {
  return smoothSubjectTrack(
    buildSubjectTrack(source.mediaId, { width: source.width, height: source.height }, observations),
  )
}

/** Crop path for every requested aspect, sharing one subject track. */
export function planReframes(
  track: SubjectTrack,
  aspects: readonly ReframeAspect[],
  options: ReframeOptions = {},
): Record<string, ReframePlan> {
  const plans: Record<string, ReframePlan> = {}
  for (const aspect of aspects) plans[aspect] = planReframe(track, aspect, options)
  return plans
}
