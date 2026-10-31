import type { JobContext, JobProgress } from '../../shared/jobs.ts'
import { throwIfAborted } from '../errors.ts'

/**
 * Options every long-running vision task accepts: the shared job runtime's cancellation signal and progress
 * callback, so a task can run inside `jobs.run` (see `fromJob`) or standalone.
 */
export interface TaskOptions {
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
}

export function fromJob(ctx: JobContext): TaskOptions & { signal: AbortSignal } {
  return { signal: ctx.signal, onProgress: (p) => ctx.progress(p) }
}

export type ProgressFn = (fraction: number, stage?: string) => void

/** Monotonic, throttled progress reporter. Always delivers the final 1.0 and stage changes. */
export function createProgress(onProgress: TaskOptions['onProgress'], minIntervalMs = 80): ProgressFn {
  let last = -1
  let lastAt = 0
  let lastStage: string | undefined
  return (fraction, stage) => {
    if (!onProgress) return
    const f = Math.min(1, Math.max(last, fraction))
    const now = Date.now()
    const stageChanged = stage !== undefined && stage !== lastStage
    if (f < 1 && !stageChanged && now - lastAt < minIntervalMs) return
    if (f === last && !stageChanged) return
    last = f
    lastAt = now
    if (stage !== undefined) lastStage = stage
    onProgress({ fraction: f, ...(lastStage !== undefined ? { stage: lastStage } : {}) })
  }
}

/** Maps a sub-task's 0..1 progress into [from, to] of the parent. */
export function subProgress(parent: ProgressFn, from: number, to: number, stage?: string): ProgressFn {
  return (fraction, subStage) =>
    parent(from + (to - from) * Math.min(1, Math.max(0, fraction)), subStage ?? stage)
}

/** Yields to the event loop and checks for cancellation; call inside long loops. */
export async function checkpoint(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  throwIfAborted(signal)
}
