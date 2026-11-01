/**
 * First-time model downloads as one line per model ("Downloading the depth estimator (27 MB, once)"): vision workers
 * report them with `modelDownloads`, the worker backends pass them to `watchDownloads` listeners whichever call
 * started them, and jobs show them with `downloadLines`.
 */
import type { JobContext, JobProgress } from '../../shared/jobs.ts'
import type { ModelFileProgress } from '../../shared/transformers.ts'
import { downloadingModel } from '../../shared/models.ts'
import { VISION_MODEL_TITLES, visionModelBytes, type VisionModel } from './models.ts'

/** A first-time download of a model's files, as a vision worker reports it. */
export interface ModelDownload extends JobProgress {
  stage: 'download'
  model: VisionModel
  message: string
  fraction: number
  /** On the last report, once the model's files are in. */
  done?: true
}

export type WatchDownloads = (listener: (download: ModelDownload) => void) => () => void

export function isModelDownload(p: JobProgress): p is ModelDownload {
  return p.stage === 'download' && 'model' in p
}

/** Model weights; configs and tokenizers are small and download alongside them. */
const WEIGHTS = /\.(onnx|tflite)$/
/** Smaller weights download in a moment and get no line (the person segmenters and face detector are 0.25 MB). */
const MIN_BYTES = 1e6
/** How far a download moves before it reports again: a file arrives in thousands of chunks. */
const STEP = 0.01

/**
 * Turns the per-file progress of loading `model` (for `withModelProgress`) into its download line for `report`:
 * how far the weights downloading in this call are, leaving out cached files, with `done` once they are in. Call
 * `end()` when the loading ends, so a download that failed is done too.
 */
export function modelDownloads(
  model: VisionModel,
  report: ((p: JobProgress) => void) | undefined,
): { file(p: ModelFileProgress): void; end(): void } {
  const files = new Map<string, { loaded: number; total: number }>()
  const message = downloadingModel(VISION_MODEL_TITLES[model], visionModelBytes(model))
  let sent = -1
  let open = false
  const send = (fraction: number) => {
    open = fraction < 1
    const d: ModelDownload = { stage: 'download', model, message, fraction, ...(open ? {} : { done: true }) }
    report?.(d)
  }
  return {
    file(p) {
      const total = p.bytesTotal ?? 0
      if (p.cached || !WEIGHTS.test(p.file) || total < MIN_BYTES) return
      files.set(p.file, { loaded: p.bytesLoaded ?? 0, total })
      let loaded = 0
      let all = 0
      for (const f of files.values()) {
        loaded += Math.min(f.loaded, f.total)
        all += f.total
      }
      const fraction = loaded / all
      if (open && fraction < 1 && fraction - sent < STEP) return
      sent = fraction
      send(fraction)
    },
    end() {
      if (open) send(1)
    },
  }
}

/**
 * A job's progress with the first-time downloads of `models` in it: while one downloads, the job shows its line
 * and how far it is, then its own line and progress again. Report through `progress` instead of `ctx.progress`,
 * and call `stop` when the job ends.
 */
export function downloadLines(
  ctx: Pick<JobContext, 'progress'>,
  vision: { watchDownloads?: WatchDownloads },
  models: readonly VisionModel[],
): { progress(p: JobProgress): void; stop(): void } {
  let own: JobProgress = {}
  const active = new Map<VisionModel, ModelDownload>()
  const stop =
    vision.watchDownloads?.((d) => {
      if (!models.includes(d.model)) return
      if (!d.done) active.set(d.model, d)
      else if (!active.delete(d.model)) return
      const shown = [...active.values()].at(-1)
      ctx.progress(
        shown
          ? { stage: 'download', fraction: shown.fraction, message: shown.message }
          : { stage: own.stage, fraction: own.fraction, message: own.message },
      )
    }) ?? (() => undefined)
  return {
    progress(p) {
      own = { ...own, ...p }
      if (!active.size) ctx.progress(p)
    },
    stop,
  }
}

/** A job's `run` with `downloadLines` for `models` in its progress. */
export function withDownloadLines<T>(
  vision: { watchDownloads?: WatchDownloads },
  models: readonly VisionModel[],
  run: (ctx: JobContext) => Promise<T>,
): (ctx: JobContext) => Promise<T> {
  return async (ctx) => {
    const lines = downloadLines(ctx, vision, models)
    try {
      return await run({ ...ctx, progress: lines.progress })
    } finally {
      lines.stop()
    }
  }
}
