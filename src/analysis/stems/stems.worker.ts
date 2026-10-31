import { detectCapabilities } from '../../shared/capabilities.ts'
import { exposeWorker } from '../../shared/worker.ts'
import { stemDevice } from './device.ts'
import { createDemucsModel } from './session.ts'
import { createStemsApi } from './worker-api.ts'

exposeWorker(
  createStemsApi({
    demucsModel: async (ctx) =>
      createDemucsModel({
        device: stemDevice(await detectCapabilities()),
        signal: ctx.signal,
        onProgress: ctx.progress,
      }),
  }),
)
