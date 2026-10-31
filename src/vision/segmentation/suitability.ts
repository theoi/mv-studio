import type { SegmentationBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { assessSuitability, type SuitabilityOptions } from '../mask/suitability.ts'
import { iterateFrames, prefetch, sampleTimes, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { Mask, SuitabilityReport, TimeRange } from '../types.ts'

export interface SuitabilityCheckOptions extends TaskOptions {
  range?: TimeRange
  /** Upper bound on analysed frames, default 90 (~2–3 s on a laptop CPU). */
  maxSamples?: number
  criteria?: SuitabilityOptions
}

/** The person track judges at the same rate, so both see the same moments. */
const STABILITY_FPS = 5
const ANALYSIS_SIDE = 256

/**
 * Quick check whether "text behind the subject" will work for a shot, before any export analysis: the same judgement
 * as the stored person track (`trackSuitability`), on raw masks. Short shots are sampled at 5 per second; long shots
 * are spread out to stay within `maxSamples`. Flicker needs consecutive frames, so this check leaves `stability`
 * null and only the person track can report an unstable mask.
 */
export async function checkSuitability(
  segmentation: SegmentationBackend,
  source: FrameSource,
  options: SuitabilityCheckOptions = {},
): Promise<SuitabilityReport> {
  const { signal } = options
  const range = options.range ?? { start: 0, end: source.duration }
  const duration = range.end - range.start
  if (!(duration > 0)) throw new JobError('invalid-input', 'The clip range is empty.')
  const maxSamples = options.maxSamples ?? 90
  const fps = Math.min(STABILITY_FPS, Math.max(0.2, maxSamples / duration))
  const times = sampleTimes(range.start, range.end, fps)
  const progress = createProgress(options.onProgress)
  try {
    progress(0, 'loading-model')
    await segmentation.configure(
      { model: source.width >= source.height ? 'selfieLandscape' : 'selfie', delegate: 'CPU' },
      { signal },
    )
    await segmentation.resetStream(null, { signal })
    const samples: Array<{ t: number; mask: Mask }> = []
    const frames = prefetch(iterateFrames(source, times, { maxSide: ANALYSIS_SIDE, signal }), 2, (f) =>
      f.bitmap.close(),
    )
    for await (const { t, bitmap } of frames) {
      const res = await segmentation.analyze(
        { bitmap, timestampMs: Math.round(t * 1000), mask: true },
        { signal, transfer: [bitmap] },
      )
      if (res.mask) samples.push({ t, mask: res.mask })
      progress(samples.length / times.length, 'analyzing')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    return assessSuitability(samples, 1 / fps, options.criteria)
  } catch (err) {
    throw visionError(err, 'internal')
  }
}
