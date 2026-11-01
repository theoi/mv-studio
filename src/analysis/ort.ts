import type * as OrtWeb from 'onnxruntime-web/webgpu'
// The ONNX Runtime build and WASM files Transformers.js uses (see src/shared/transformers.ts), so the app ships one
// ONNX Runtime binary for every model.
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { BeatThisModel } from './beats/beatThis.ts'
import { BEAT_THIS_MODEL, MODEL_TITLES } from './models.ts'
import { configureOnnxEnv, downloadingModel, loadModelFiles, modelBytes, theModel } from '../shared/models.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'

type Ort = typeof OrtWeb
let ortPromise: Promise<Ort> | undefined

/** Loads ONNX Runtime (WASM and WebGPU) once per worker and applies the shared thread policy before the first session. */
export function loadOrt(): Promise<Ort> {
  ortPromise ??= (async () => {
    const ort = await import('onnxruntime-web/webgpu')
    await configureOnnxEnv(ort.env)
    ort.env.wasm.wasmPaths = {
      mjs: new URL(ortMjsUrl, self.location.href).href,
      wasm: new URL(ortWasmUrl, self.location.href).href,
    }
    return ort
  })()
  ortPromise.catch(() => {
    ortPromise = undefined
  })
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
      title: MODEL_TITLES.beats,
      onProgress: (p) =>
        options.onProgress?.({
          ...p,
          stage: 'download',
          message: downloadingModel(MODEL_TITLES.beats, modelBytes(BEAT_THIS_MODEL)),
        }),
    })
    let s: OrtWeb.InferenceSession
    try {
      s = await ort.InferenceSession.create(new Uint8Array(files.model), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
    } catch (error) {
      throw new JobError('model-load', `Couldn’t start ${theModel(MODEL_TITLES.beats)}`, { cause: error })
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
