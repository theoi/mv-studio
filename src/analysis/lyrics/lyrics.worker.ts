import { modelCache } from '../../shared/models.ts'
import { withModelProgress } from '../../shared/transformers.ts'
import { exposeWorker } from '../../shared/worker.ts'
import { WHISPER_MODELS, whisperFileUrls } from '../models.ts'
import { whisperLoadProgress } from './loadProgress.ts'
import { createCtcModel } from './session.ts'
import { createWhisperTranscriber } from './whisperModel.ts'
import { createLyricsApi } from './worker-api.ts'

let ctc: ReturnType<typeof createCtcModel> | undefined

exposeWorker(
  createLyricsApi({
    ctcModel: (ctx) => {
      ctc ??= createCtcModel({ signal: ctx.signal, onProgress: ctx.progress })
      ctc.catch(() => {
        ctc = undefined
      })
      return ctc
    },
    // WASM until Whisper on WebGPU has been measured on real GPUs.
    transcriber: async (size, ctx) => {
      const spec = WHISPER_MODELS[size]
      const cached = (await Promise.all(whisperFileUrls(spec).map((url) => modelCache.has(url)))).every(
        Boolean,
      )
      const transcriber = await withModelProgress(whisperLoadProgress(spec, cached, ctx.progress), () =>
        createWhisperTranscriber(spec, 'wasm'),
      )
      return { transcriber, device: 'wasm', dispose: transcriber.dispose }
    },
  }),
)
