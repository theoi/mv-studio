/**
 * First-time model downloads as one line per model ("Downloading the depth estimator (27 MB, once)"): vision workers
 * report them with `modelDownloads`, the worker backends pass them to `watchDownloads` listeners whichever call
 * started them (`routeDownloads`), and jobs show them with `downloadLines`.
 */
import type { JobContext, JobProgress } from '../../shared/jobs.ts'
import type { ModelFileProgress } from '../../shared/transformers.ts'
import { downloadingModel } from '../../shared/models.ts'
import {
  isVisionModelFile,
  VISION_MODEL_TITLES,
  visionModelBytes,
  type VisionDtype,
  type VisionModel,
} from './models.ts'

/** A first-time download of a model's files, as a vision worker reports it. */
export interface ModelDownload extends JobProgress {
  stage: 'download'
  model: VisionModel
  message: string
  /** How far the download is, by its bytes. */
  fraction: number
  bytesLoaded: number
  bytesTotal: number
  /** On the last report, once the model's files are in. */
  done?: true
}

export type WatchDownloads = (listener: (download: ModelDownload) => void) => () => void

/** Where a job's download lines come from (a vision service), and optionally who hears which one it shows. */
export interface DownloadSource {
  watchDownloads?: WatchDownloads | undefined
  /** The download the job shows as its line, null once it shows its own line again. */
  onLine?: (download: ModelDownload | null) => void
}

export function isModelDownload(p: JobProgress): p is ModelDownload {
  return p.stage === 'download' && 'model' in p
}

/** Model weights; configs and tokenizers are small and download alongside them. */
const WEIGHTS = /\.(onnx|tflite)$/
/** Smaller weights download in a moment and get no line (the person segmenters and face detector are 0.25 MB). */
const MIN_BYTES = 1e6
/** How far a download moves before it reports again: a file arrives in thousands of chunks. */
const STEP = 0.01
/** The share of what is left of a job's bar that its downloads fill. */
const DOWNLOAD_SHARE = 0.5

/**
 * Turns the per-file progress of loading `model` (for `withModelProgress`) into its download line for `report`, with
 * the model's size in `dtype`: how far its weights downloading in this call are, leaving out cached files, with
 * `done` once they are in. Call `end()` when the loading ends, so a download that failed is done too. Other models'
 * files are left out: a worker sends file progress to its latest call, and calls can overlap.
 */
export function modelDownloads(
  model: VisionModel,
  report: ((p: JobProgress) => void) | undefined,
  dtype?: VisionDtype,
): { file(p: ModelFileProgress): void; end(): void } {
  const files = new Map<string, { loaded: number; total: number }>()
  const message = downloadingModel(VISION_MODEL_TITLES[model], visionModelBytes(model, dtype))
  let sent = -1
  let open = false
  let bytes = { bytesLoaded: 0, bytesTotal: 0 }
  const send = (fraction: number) => {
    open = fraction < 1
    const d: ModelDownload = {
      stage: 'download',
      model,
      message,
      fraction,
      ...bytes,
      ...(open ? {} : { done: true }),
    }
    report?.(d)
  }
  return {
    file(p) {
      const total = p.bytesTotal ?? 0
      if (p.cached || !WEIGHTS.test(p.file) || total < MIN_BYTES) return
      if (!p.url || !isVisionModelFile(model, p.url)) return
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
      bytes = { bytesLoaded: loaded, bytesTotal: all }
      send(fraction)
    },
    end() {
      if (open) send(1)
    },
  }
}

/**
 * Runs a worker call with the model downloads it reports going to `downloads` instead of `onProgress`. Downloads
 * still open when the call settles end there too: a call that was cancelled, or whose worker died, never gets the
 * worker's last report, and the jobs watching the model would keep its line.
 */
export function routeDownloads<R>(
  call: (onProgress: (p: JobProgress) => void) => Promise<R>,
  onProgress: ((p: JobProgress) => void) | undefined,
  downloads: (d: ModelDownload) => void,
): Promise<R> {
  const open = new Map<VisionModel, ModelDownload>()
  return call((p) => {
    if (!isModelDownload(p)) return onProgress?.(p)
    if (p.done) open.delete(p.model)
    else open.set(p.model, p)
    downloads(p)
  }).finally(() => {
    for (const d of open.values()) downloads({ ...d, fraction: 1, done: true })
  })
}

/**
 * A job's progress with the first-time downloads of `models` in it: while one downloads, the job shows its line,
 * with how far the download is in `bytesLoaded` and `bytesTotal`, and the bar fills half of what is left of it as
 * the download goes. Then the job's own line comes back, with its own progress over the rest of the bar, so the bar
 * never goes back. Report through `progress` instead of `ctx.progress`, and call `stop` when the job ends.
 */
export function downloadLines(
  ctx: Pick<JobContext, 'progress'>,
  vision: DownloadSource,
  models: readonly VisionModel[],
): { progress(p: JobProgress): void; stop(): void } {
  let own: JobProgress = {}
  /** The fraction the job shows. */
  let bar = 0
  /** The bar when the downloads showing now started. */
  let start = 0
  /** Once a download has ended: the bar then, and the job's own fraction then, which its later ones go on from. */
  let after: { bar: number; own: number } | null = null
  const active = new Map<VisionModel, ModelDownload>()
  const show = (p: JobProgress) => {
    if (p.fraction !== undefined) bar = p.fraction
    ctx.progress(p)
  }
  const onBar = (f: number) => {
    if (!after) return f
    const left = 1 - after.own
    return Math.max(after.bar, left > 0 ? after.bar + ((1 - after.bar) * (f - after.own)) / left : f)
  }
  const stop =
    vision.watchDownloads?.((d) => {
      if (!models.includes(d.model)) return
      if (!d.done) {
        if (!active.size) start = bar
        active.set(d.model, d)
      } else if (!active.delete(d.model)) return
      const shown = [...active.values()].at(-1)
      if (shown) {
        const fraction = Math.max(bar, start + (1 - start) * DOWNLOAD_SHARE * shown.fraction)
        const { message, bytesLoaded, bytesTotal } = shown
        show({ stage: 'download', fraction, message, bytesLoaded, bytesTotal })
      } else {
        after = { bar, own: own.fraction ?? 0 }
        const { stage, message, bytesLoaded, bytesTotal } = own
        show({ stage, fraction: bar, message, bytesLoaded, bytesTotal })
      }
      vision.onLine?.(shown ?? null)
    }) ?? (() => undefined)
  return {
    progress(p) {
      own = { ...own, ...p }
      if (active.size) return
      show(p.fraction === undefined ? p : { ...p, fraction: onBar(p.fraction) })
    },
    stop,
  }
}

/** A job's `run` with `downloadLines` for `models` in its progress. */
export function withDownloadLines<T>(
  vision: DownloadSource,
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
