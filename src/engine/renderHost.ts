/**
 * Main-thread side of the render worker (render.worker.ts). The worker renders with its own WebGL context on an
 * OffscreenCanvas and reads media straight from OPFS (export) or through the page's media source (preview), so however
 * slow the GPU (or a GPU-less machine's software renderer) is, rendering never blocks input on the main thread.
 */
import { JobError } from '../shared/jobs.ts'
import { createWorkerClient, type CallOptions } from '../shared/worker.ts'
import type { EncodeJob, EncodeResult } from './encode.ts'
import { serveMedia, type PreviewRenderRequest } from './previewWorker.ts'
import type { RenderWorkerApi } from './render.worker.ts'
import type { MediaFileSource } from './types.ts'

export interface RenderWorker {
  /**
   * Renders and encodes an export (encodeExport). Pass the audio channel buffers in `options.transfer`. On cancel, the
   * call settles once the worker has stopped writing. If the worker dies, rejects with 'worker-crashed' or
   * 'out-of-memory'.
   */
  exportVideo(job: EncodeJob, options?: CallOptions): Promise<EncodeResult>
  /** Terminates the worker; pending calls reject with 'cancelled'. */
  dispose(): void
}

function spawnRenderWorker(name: string) {
  return createWorkerClient<RenderWorkerApi>(
    new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name }),
  )
}

export function startRenderWorker(): RenderWorker {
  const client = spawnRenderWorker('render')
  return {
    exportVideo: (job, options) => client.call('exportVideo', job, { ...options, awaitCancel: true }),
    dispose: () => client.terminate(),
  }
}

export interface PreviewWorker {
  /** Draws a frame; pass the request's VideoFrames in `transfer`. Resolves with the frame when `capture` is set. */
  render(request: PreviewRenderRequest, transfer: Transferable[]): Promise<ImageBitmap | null>
  /** The frame drawn last; needs preserveDrawingBuffer. */
  capture(): Promise<ImageBitmap>
  /** The error the worker died with, or null. A dead worker cannot draw again: the canvas went with it. */
  failure(): JobError | null
  dispose(): void
}

/** A worker that has not loaded and answered within this time counts as unavailable. */
const PREVIEW_START_TIMEOUT_MS = 15_000

/**
 * Starts a render worker for a preview and moves `canvas` into it. Rejects with the canvas untouched when the worker
 * cannot draw, so the caller can draw on the main thread instead.
 */
export async function startPreviewWorker(
  canvas: HTMLCanvasElement,
  media: MediaFileSource,
  options: { preserveDrawingBuffer?: boolean } = {},
): Promise<PreviewWorker> {
  const client = spawnRenderWorker('preview')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new JobError('internal', 'The preview worker did not start')),
      PREVIEW_START_TIMEOUT_MS,
    )
  })
  const channel = new MessageChannel()
  try {
    await Promise.race([client.call('previewProbe', undefined), timeout])
    const offscreen = canvas.transferControlToOffscreen()
    serveMedia(channel.port1, media)
    await client.call(
      'previewStart',
      {
        canvas: offscreen,
        port: channel.port2,
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      },
      { transfer: [offscreen, channel.port2] },
    )
  } catch (error) {
    client.terminate()
    channel.port1.close()
    throw error
  } finally {
    clearTimeout(timer)
  }
  return {
    render: (request, transfer) => client.call('previewRender', request, { transfer }).then((r) => r.bitmap),
    capture: () => client.call('previewCapture', undefined).then((r) => r.bitmap),
    failure: () => client.failure(),
    dispose: () => {
      client.terminate()
      channel.port1.close()
    },
  }
}
