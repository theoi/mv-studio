import { detectCapabilities } from '../../shared/capabilities.ts'
import { preferredDevice } from '../../shared/models.ts'
import { exposeWorker } from '../../shared/worker.ts'
import { createDemucsModel } from './session.ts'
import { createStemsApi } from './worker-api.ts'

exposeWorker(
  createStemsApi({
    demucsModel: async (ctx) => {
      const caps = await detectCapabilities()
      // A software WebGPU adapter (SwiftShader) is about 50 times slower than WASM threads for this model.
      const software = /swiftshader/i.test(caps.webgpu.adapter ?? '')
      return createDemucsModel({
        device: software ? 'wasm' : preferredDevice(caps),
        signal: ctx.signal,
        onProgress: ctx.progress,
      })
    },
  }),
)
