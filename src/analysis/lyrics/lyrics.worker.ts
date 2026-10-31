import { withModelProgress } from '../../shared/transformers.ts'
import { exposeWorker } from '../../shared/worker.ts'
import { WHISPER_MODELS } from '../models.ts'
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
      const transcriber = await withModelProgress(ctx.progress, () =>
        createWhisperTranscriber(WHISPER_MODELS[size], 'wasm'),
      )
      return { transcriber, device: 'wasm', dispose: transcriber.dispose }
    },
  }),
)
