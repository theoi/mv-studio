/** The render worker: compositor, decoders and encoders on their own thread (see renderHost.ts). */
import { JobError } from '../shared/jobs.ts'
import { exposeWorker, transfer, type WorkerCallContext } from '../shared/worker.ts'
import type { EncodeJob } from './encode.ts'
import type { BridgedVideo } from './frames.ts'
import type { PreviewRenderRequest, WorkerPreview } from './previewWorker.ts'

// The compositor and encoders load on first use: with only this module and worker.ts to evaluate first, the worker
// takes the client's watch lock (worker.ts) moments after it starts, and its death can be noticed from then on.

let preview: Promise<WorkerPreview> | null = null

function activePreview(): Promise<WorkerPreview> {
  if (!preview) throw new JobError('internal', 'The worker preview has not started')
  return preview
}

const api = {
  /** With `media`, a port served by the page's media source (serveMedia), files come from the page, else from OPFS. */
  exportVideo: async ({ job, media }: { job: EncodeJob; media?: MessagePort }, ctx: WorkerCallContext) => {
    try {
      const [{ encodeExport }, source] = await Promise.all([
        import('./encode.ts'),
        media
          ? import('./previewWorker.ts').then(({ portMedia }) => portMedia(media))
          : import('../media/mediaStore.ts').then(({ mediaStore }) => mediaStore),
      ])
      return await encodeExport(job, ctx, { media: source })
    } finally {
      media?.close()
    }
  },
  /**
   * Checks that this worker can draw before it gets work: before the main thread moves a preview's canvas here (which
   * cannot be undone) or sends an export, which then run on the main thread instead.
   */
  probe: () => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (!gl) throw new JobError('unsupported', 'WebGL2 is not available in workers')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  },
  /** Render calls sent right after this one wait for the preview it starts. */
  previewStart: async (args: {
    canvas: OffscreenCanvas
    port: MessagePort
    preserveDrawingBuffer: boolean
  }) => {
    const previous = preview
    preview = import('./previewWorker.ts').then(
      ({ portMedia, WorkerPreview }) =>
        new WorkerPreview(args.canvas, portMedia(args.port), args.preserveDrawingBuffer),
    )
    previous?.then((p) => p.dispose()).catch(() => undefined)
    await preview
    return true
  },
  // A staged frame must reach the preview before the render that names it, which the page sends after it: this and
  // previewRender wait the same way, so they reach the preview in the order they came.
  previewStage: async (video: BridgedVideo) => {
    ;(await activePreview()).stage(video)
    return true
  },
  previewRender: async (request: PreviewRenderRequest) => {
    const bitmap = await (await activePreview()).render(request)
    return transfer({ bitmap }, bitmap ? [bitmap] : [])
  },
  /** Not queued behind the frames still to draw: the page asks right after a measured frame's reply. */
  previewDrawnMs: async () => (await activePreview()).drawnMs(),
  previewCapture: async () => {
    const bitmap = await (await activePreview()).capture()
    return transfer({ bitmap }, [bitmap])
  },
  /**
   * Closes the preview's video frames and GL objects once its queued frames are drawn. The main thread calls it before
   * terminating this worker: the browser reports frames a terminated worker still holds as never closed.
   */
  previewStop: async () => {
    const current = preview
    preview = null
    if (current) await (await current).stop()
    return true
  },
}

export type RenderWorkerApi = typeof api

exposeWorker(api)
