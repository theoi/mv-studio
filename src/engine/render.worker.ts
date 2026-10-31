/** The render worker: compositor, decoders and encoders on their own thread (see renderHost.ts). */
import { mediaStore } from '../media/mediaStore.ts'
import { exposeWorker, type WorkerCallContext } from '../shared/worker.ts'
import { encodeExport, type EncodeJob } from './encode.ts'

const api = {
  exportVideo: (job: EncodeJob, ctx: WorkerCallContext) => encodeExport(job, ctx, { media: mediaStore }),
}

export type RenderWorkerApi = typeof api

exposeWorker(api)
