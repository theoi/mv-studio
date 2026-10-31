import type { SegmentationBackend } from '../backends.ts'
import { visionError } from '../errors.ts'
import { createCausalSmoother, type CausalSmootherOptions } from '../mask/smoothing.ts'
import type { Mask } from '../types.ts'

export interface LivePreviewOptions {
  /** false disables temporal smoothing. */
  smoothing?: CausalSmootherOptions | false
  /** A jump larger than this (seconds, or any step backwards) restarts smoothing. */
  seekThreshold?: number
}

export interface LivePreviewSegmenter {
  /**
   * Person mask for a playback frame (pass it small, ~256 px long side; the compositor
   * upsamples edge-aware). Resolves null when a newer frame superseded this one before it
   * was processed, so slow devices drop frames instead of lagging. The bitmap is consumed.
   */
  segment(bitmap: ImageBitmap, t: number): Promise<Mask | null>
  /** Call after seeking or switching clips. */
  reset(): void
  /** Rejects nothing; resolves pending frames with null. */
  dispose(): void
}

interface Pending {
  bitmap: ImageBitmap
  t: number
  resolve: (mask: Mask | null) => void
  reject: (err: unknown) => void
}

export function createLivePreview(
  backend: SegmentationBackend,
  options: LivePreviewOptions = {},
): LivePreviewSegmenter {
  const smoother = options.smoothing === false ? null : createCausalSmoother(options.smoothing ?? {})
  const seekThreshold = options.seekThreshold ?? 0.5
  let queued: Pending | null = null
  let running = false
  let lastT: number | null = null
  let disposed = false

  const pump = async () => {
    running = true
    while (queued) {
      const job = queued
      queued = null
      try {
        if (lastT !== null && (job.t < lastT || job.t - lastT > seekThreshold)) smoother?.reset()
        lastT = job.t
        const res = await backend.analyze(
          { bitmap: job.bitmap, timestampMs: Math.round(job.t * 1000), mask: true, gray: smoother !== null },
          { transfer: [job.bitmap] },
        )
        if (!res.mask || disposed) {
          job.resolve(null)
          continue
        }
        job.resolve(smoother ? smoother.push(res.mask, res.gray) : res.mask)
      } catch (err) {
        job.reject(visionError(err, 'internal'))
      }
    }
    running = false
  }

  return {
    segment(bitmap, t) {
      if (disposed) {
        bitmap.close()
        return Promise.resolve(null)
      }
      return new Promise((resolve, reject) => {
        if (queued) {
          queued.bitmap.close()
          queued.resolve(null)
        }
        queued = { bitmap, t, resolve, reject }
        if (!running) void pump()
      })
    },
    reset() {
      smoother?.reset()
      lastT = null
      void backend.resetStream(null).catch(() => undefined)
    },
    dispose() {
      disposed = true
      if (queued) {
        queued.bitmap.close()
        queued.resolve(null)
        queued = null
      }
    },
  }
}
