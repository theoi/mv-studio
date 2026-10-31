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
  /** How long the last frame rendered with `measure` took to draw, once the GPU has drawn it; null when unknown. */
  drawnMs(): Promise<number | null>
  /**
   * Why the worker can no longer draw, or null: it died ('worker-crashed', 'out-of-memory'), failed to start, or did
   * not answer in time while starting ('timeout'). The canvas went with it.
   */
  failure(): JobError | null
  dispose(): void
}

/**
 * Until a worker has drawn its first frame, it counts as dead when a call takes longer than this. Calls made before
 * it holds its watch lock (worker.ts) would otherwise wait forever if it was stopped then.
 */
const PREVIEW_START_TIMEOUT_MS = 15_000

/** How long a closing preview's worker gets to close its frames before it is terminated anyway. */
const PREVIEW_STOP_TIMEOUT_MS = 1000

/** `promise`, or a rejection with `timedOut` after `ms`. */
function within<T>(promise: Promise<T>, ms: number, timedOut: JobError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Starts a render worker for a preview and moves `canvas` into it. Rejects with the canvas untouched when the worker
 * cannot draw or does not answer in time, so the caller can draw on the main thread instead. Once the canvas has
 * moved, the worker failing to start, dying, or not drawing its first frame in time makes render() reject and sets
 * failure().
 */
export async function startPreviewWorker(
  canvas: HTMLCanvasElement,
  media: MediaFileSource,
  options: { preserveDrawingBuffer?: boolean } = {},
): Promise<PreviewWorker> {
  const client = spawnRenderWorker('preview')
  const channel = new MessageChannel()
  const stop = () => {
    client.terminate()
    channel.port1.close()
  }
  try {
    await within(
      client.call('previewProbe', undefined),
      PREVIEW_START_TIMEOUT_MS,
      new JobError('timeout', 'The preview worker did not start'),
    )
  } catch (error) {
    stop()
    throw error
  }
  const offscreen = canvas.transferControlToOffscreen()
  serveMedia(channel.port1, media)

  let failure: JobError | null = null
  const fail = (error: JobError): JobError => {
    failure ??= error
    stop()
    return failure
  }
  const timedOut = new JobError('timeout', 'The preview worker stopped responding')
  /** Rejects with the failure once the worker is taken for dead (or failed, with `fatal`); other errors pass. */
  const starting = <T>(call: Promise<T>, fatal: boolean): Promise<T> =>
    within(call, PREVIEW_START_TIMEOUT_MS, timedOut).catch((error: unknown) => {
      const death = client.failure() ?? (error === timedOut || fatal ? JobError.from(error) : null)
      throw death ? fail(death) : (failure ?? error)
    })
  // Render calls sent meanwhile wait in the worker for this start, so its failure is theirs.
  starting(
    client.call(
      'previewStart',
      {
        canvas: offscreen,
        port: channel.port2,
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      },
      { transfer: [offscreen, channel.port2] },
    ),
    true,
  ).catch(() => undefined)
  let drawn = false
  const dead = () => failure ?? client.failure()
  return {
    render: (request, transfer) => {
      const error = dead()
      if (error) {
        for (const t of transfer) if (t instanceof VideoFrame) t.close()
        return Promise.reject(error)
      }
      const call = client.call('previewRender', request, { transfer }).then((r) => r.bitmap)
      if (drawn) return call
      return starting(call, false).then((bitmap) => {
        drawn = true
        return bitmap
      })
    },
    capture: () => {
      const error = dead()
      if (error) return Promise.reject(error)
      return client.call('previewCapture', undefined).then((r) => r.bitmap)
    },
    drawnMs: () =>
      dead() ? Promise.resolve(null) : client.call('previewDrawnMs', undefined).catch(() => null),
    failure: dead,
    dispose: () => {
      if (dead()) {
        stop()
        return
      }
      // The browser reports video frames a terminated worker still holds as garbage collected without being closed.
      void within(client.call('previewStop', undefined), PREVIEW_STOP_TIMEOUT_MS, timedOut)
        .catch(() => undefined)
        .finally(stop)
    },
  }
}
