import type * as OrtWeb from 'onnxruntime-web/wasm'
import type { BeatThisModel } from './beats/beatThis.ts'
import { BEAT_THIS_MODEL } from './models.ts'
import { configureOnnxEnv, loadModelFiles } from '../shared/models.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'

type Ort = typeof OrtWeb
let ortPromise: Promise<Ort> | undefined

/**
 * Loads the WASM-only ONNX Runtime build once per worker and applies the shared thread policy before the first
 * session. Beat This! runs in seconds on WASM threads, and the WebGPU build is a 29 MB download instead of 15 MB.
 */
export function loadOrt(): Promise<Ort> {
  ortPromise ??= (async () => {
    const ort = await import('onnxruntime-web/wasm')
    await configureOnnxEnv(ort.env)
    return ort
  })()
  return ortPromise
}

let session: Promise<BeatThisModel> | undefined

/** Beat This! session, created once per worker. */
export function beatThisModel(
  options: { signal?: AbortSignal; onProgress?: (p: JobProgress) => void } = {},
): Promise<BeatThisModel> {
  session ??= (async () => {
    const ort = await loadOrt()
    const files = await loadModelFiles(BEAT_THIS_MODEL, {
      signal: options.signal,
      onProgress: (p) =>
        options.onProgress?.({
          ...p,
          stage: 'download',
          message: 'Downloading the beat model (82 MB, once)',
        }),
    })
    let s: OrtWeb.InferenceSession
    try {
      s = await ort.InferenceSession.create(new Uint8Array(files.model), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
    } catch (error) {
      throw new JobError('model-load', 'Could not start the beat model', { cause: error })
    }
    const input = s.inputNames[0]
    return {
      async run(spect, frames) {
        const tensor = new ort.Tensor('float32', spect, [1, frames, 128])
        const out = await s.run({ [input]: tensor })
        tensor.dispose()
        const beat = Float32Array.from(out.beat.data as Float32Array)
        const downbeat = Float32Array.from(out.downbeat.data as Float32Array)
        out.beat.dispose()
        out.downbeat.dispose()
        return { beat, downbeat }
      },
    }
  })()
  session.catch(() => {
    session = undefined
  })
  return session
}
