/**
 * Main-thread side of the render worker (render.worker.ts). The worker renders with its own WebGL context on an
 * OffscreenCanvas and reads media through the page's media source (serveMedia), or straight from OPFS for an export
 * given none, so however slow the GPU (or a GPU-less machine's software renderer) is, rendering never blocks input on
 * the main thread. A worker is asked whether it can draw before it gets any work; when it can't, the preview and
 * exports draw on the main thread instead.
 */
import { JobError } from '../shared/jobs.ts'
import { createWorkerClient, type CallOptions } from '../shared/worker.ts'
import type { EncodeJob, EncodeResult, ExportProbe, ProbeJob } from './encode.ts'
import type { BridgedVideo } from './frames.ts'
import { serveMedia, type PreviewRenderRequest } from './previewWorker.ts'
import type { RenderWorkerApi } from './render.worker.ts'
import type { MediaFileSource } from './types.ts'

export interface RenderWorker {
  /**
   * Renders and encodes an export (encodeExport). Pass the audio channel buffers in `options.transfer`. With `media`,
   * the worker reads files through the page's media source instead of straight from OPFS. On cancel, the call settles
   * once the worker has stopped writing. If the worker dies, rejects with 'worker-crashed' or 'out-of-memory'.
   */
  exportVideo(job: EncodeJob, options?: CallOptions, media?: MediaFileSource): Promise<EncodeResult>
  /** Times a trial render of some of an export's frames (measureExport), reading files as exportVideo does. */
  probeExport(job: ProbeJob, options?: CallOptions, media?: MediaFileSource): Promise<ExportProbe>
  /** Terminates the worker; pending calls reject with 'cancelled'. */
  dispose(): void
}

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

function spawnRenderWorker(name: string) {
  return createWorkerClient<RenderWorkerApi>(
    new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name }),
  )
}

/**
 * Until a worker has answered that it can draw, and for a preview until it has drawn its first frame, it counts as
 * dead when a call takes longer than this. Calls made before it holds its watch lock (worker.ts) would otherwise wait
 * forever if it was stopped then.
 */
const WORKER_START_TIMEOUT_MS = 15_000

/** Resolves once a new worker says it can draw; else stops it and rejects (unsupported, crashed or timeout). */
async function whenItCanDraw(client: ReturnType<typeof spawnRenderWorker>, role: string): Promise<void> {
  try {
    await within(
      client.call('probe', undefined),
      WORKER_START_TIMEOUT_MS,
      new JobError('timeout', `The ${role} worker did not start`),
    )
  } catch (error) {
    client.terminate()
    throw error
  }
}

/** Runs `call` with the worker's end of a port served by `media`, or with none; the page's end closes after. */
async function withMediaPort<T>(
  media: MediaFileSource | undefined,
  call: (port: MessagePort | undefined) => Promise<T>,
): Promise<T> {
  if (!media) return call(undefined)
  const channel = new MessageChannel()
  serveMedia(channel.port1, media)
  try {
    return await call(channel.port2)
  } finally {
    channel.port1.close()
  }
}

/**
 * Starts a render worker for an export. Rejects, with the worker stopped, when it cannot draw (no WebGL2 in workers),
 * fails to start or does not answer in time, so the caller can export on the main thread instead.
 */
export async function startRenderWorker(): Promise<RenderWorker> {
  const client = spawnRenderWorker('render')
  await whenItCanDraw(client, 'render')
  return {
    exportVideo: (job, options = {}, media) =>
      withMediaPort(media, (port) =>
        client.call(
          'exportVideo',
          { job, media: port },
          { ...options, transfer: [...(options.transfer ?? []), ...(port ? [port] : [])], awaitCancel: true },
        ),
      ),
    probeExport: (job, options = {}, media) =>
      withMediaPort(media, (port) =>
        client.call(
          'probeExport',
          { job, media: port },
          { ...options, transfer: port ? [port] : [], awaitCancel: true },
        ),
      ),
    dispose: () => client.terminate(),
  }
}

export interface PreviewWorker {
  /** Draws a frame; pass the request's VideoFrames in `transfer`. Resolves with the frame when `capture` is set. */
  render(request: PreviewRenderRequest, transfer: Transferable[]): Promise<ImageBitmap | null>
  /** Sends a video frame of the next render ahead of it (WorkerPreview.stage), taking the frame. */
  stage(video: BridgedVideo): void
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

/** How long a closing preview's worker gets to close its frames before it is terminated anyway. */
const PREVIEW_STOP_TIMEOUT_MS = 1000

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
  await whenItCanDraw(client, 'preview')
  const channel = new MessageChannel()
  const stop = () => {
    client.terminate()
    channel.port1.close()
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
    within(call, WORKER_START_TIMEOUT_MS, timedOut).catch((error: unknown) => {
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
    stage: (video) => {
      if (dead()) {
        video.frame?.close()
        return
      }
      // A failure shows in the render that names the frame.
      void client
        .call('previewStage', video, { transfer: video.frame ? [video.frame] : [] })
        .catch(() => undefined)
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
