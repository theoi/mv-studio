import { exposeWorker } from '../shared/worker.ts'
import { beatThisModel } from './ort.ts'
import { createAnalysisApi } from './worker-api.ts'

exposeWorker(
  createAnalysisApi({
    beatThisModel: (ctx) => beatThisModel({ signal: ctx.signal, onProgress: ctx.progress }),
  }),
)
