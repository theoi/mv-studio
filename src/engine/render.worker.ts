/** The render worker: compositor, decoders and encoders on their own thread (see renderHost.ts). */
import { mediaStore } from '../media/mediaStore.ts'
import { JobError } from '../shared/jobs.ts'
import { exposeWorker, transfer, type WorkerCallContext } from '../shared/worker.ts'
import { encodeExport, type EncodeJob } from './encode.ts'
import { portMedia, WorkerPreview, type PreviewRenderRequest } from './previewWorker.ts'

let preview: WorkerPreview | null = null

function activePreview(): WorkerPreview {
  if (!preview) throw new JobError('internal', 'The worker preview has not started')
  return preview
}

const api = {
  exportVideo: (job: EncodeJob, ctx: WorkerCallContext) => encodeExport(job, ctx, { media: mediaStore }),
  /** Checks that this worker can draw before the main thread moves its canvas here (which cannot be undone). */
  previewProbe: () => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (!gl) throw new JobError('unsupported', 'WebGL2 is not available in workers')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  },
  previewStart: (args: { canvas: OffscreenCanvas; port: MessagePort; preserveDrawingBuffer: boolean }) => {
    preview?.dispose()
    preview = new WorkerPreview(args.canvas, portMedia(args.port), args.preserveDrawingBuffer)
    return true
  },
  previewRender: async (request: PreviewRenderRequest) => {
    const bitmap = await activePreview().render(request)
    return transfer({ bitmap }, bitmap ? [bitmap] : [])
  },
  previewCapture: async () => {
    const bitmap = await activePreview().capture()
    return transfer({ bitmap }, [bitmap])
  },
}

export type RenderWorkerApi = typeof api

exposeWorker(api)
