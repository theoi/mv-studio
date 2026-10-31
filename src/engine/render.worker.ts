/** The render worker: compositor, decoders and encoders on their own thread (see renderHost.ts). */
import { JobError } from '../shared/jobs.ts'
import { exposeWorker, transfer, type WorkerCallContext } from '../shared/worker.ts'
import type { EncodeJob } from './encode.ts'
import type { PreviewRenderRequest, WorkerPreview } from './previewWorker.ts'

// The compositor and encoders load on first use: with only this module and worker.ts to evaluate first, the worker
// takes the client's watch lock (worker.ts) moments after it starts, and its death can be noticed from then on.

let preview: Promise<WorkerPreview> | null = null

function activePreview(): Promise<WorkerPreview> {
  if (!preview) throw new JobError('internal', 'The worker preview has not started')
  return preview
}

const api = {
  exportVideo: async (job: EncodeJob, ctx: WorkerCallContext) => {
    const [{ encodeExport }, { mediaStore }] = await Promise.all([
      import('./encode.ts'),
      import('../media/mediaStore.ts'),
    ])
    return encodeExport(job, ctx, { media: mediaStore })
  },
  /** Checks that this worker can draw before the main thread moves its canvas here (which cannot be undone). */
  previewProbe: () => {
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
