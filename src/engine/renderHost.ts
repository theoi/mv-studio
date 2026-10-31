/**
 * Main-thread side of the render worker (render.worker.ts). The worker renders with its own WebGL context on an
 * OffscreenCanvas and reads media straight from OPFS, so however slow the GPU (or a GPU-less machine's software
 * renderer) is, rendering never blocks input on the main thread.
 */
import { JobError } from '../shared/jobs.ts'
import { createWorkerClient, type CallOptions } from '../shared/worker.ts'
import type { EncodeJob, EncodeResult } from './encode.ts'
import type { RenderWorkerApi } from './render.worker.ts'

export interface RenderWorker {
  /**
   * Renders and encodes an export (encodeExport). Pass the audio channel buffers in `options.transfer`. On cancel, the
   * call settles once the worker has stopped writing.
   */
  exportVideo(job: EncodeJob, options?: CallOptions): Promise<EncodeResult>
  /** Terminates the worker; pending calls reject with 'cancelled'. */
  dispose(): void
}

export function startRenderWorker(): RenderWorker {
  const worker = new Worker(new URL('./render.worker.ts', import.meta.url), {
    type: 'module',
    name: 'render',
  })
  const client = createWorkerClient<RenderWorkerApi>(worker)
  // An error outside a call (the module failed to load, or the worker crashed) would otherwise leave calls pending.
  const died = new Promise<never>((_, reject) => {
    worker.addEventListener(
      'error',
      (event) => {
        event.preventDefault()
        reject(
          new JobError('internal', `The render worker stopped${event.message ? `: ${event.message}` : ''}`),
        )
      },
      { once: true },
    )
  })
  died.catch(() => undefined)
  return {
    exportVideo: (job, options) =>
      Promise.race([client.call('exportVideo', job, { ...options, awaitCancel: true }), died]),
    dispose: () => client.terminate(),
  }
}
