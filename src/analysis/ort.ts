import type * as OrtWeb from 'onnxruntime-web/webgpu'
// The ONNX Runtime build and WASM files Transformers.js uses (see src/shared/transformers.ts), so the app ships one
// ONNX Runtime binary for every model.
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { BeatThisModel } from './beats/beatThis.ts'
import { BEAT_THIS_MODEL, MODEL_TITLES } from './models.ts'
import { detectCapabilities } from '../shared/capabilities.ts'
import { configureOnnxEnv, downloadingModel, loadModelFiles, modelBytes, theModel } from '../shared/models.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'

type Ort = typeof OrtWeb
let ortPromise: Promise<Ort> | undefined

/**
 * ONNX Runtime threads for work that runs in the background while the user edits: half the cores, within the shared
 * policy and the user's thread limit. Beat This! runs a whole song as one worker call, and on cores − 1 threads it
 * starved the preview's video decoder, so seeks during it took about a second longer. On 4 cores (2 threads instead of
 * 3) refinement takes about 6% longer while the preview decodes, and about 40% longer when nothing else runs.
 */
export function backgroundThreadCount(wasmThreads: number, cores: number): number {
  return Math.min(wasmThreads, Math.max(1, Math.ceil(cores / 2)))
}

/**
 * Loads ONNX Runtime (WASM and WebGPU) once per worker and applies the shared thread policy before the first session;
 * `background` takes backgroundThreadCount() instead. ORT fixes its thread pool at the first session, so the first call
 * in a worker decides: the analysis worker runs only Beat This!, while stems and lyrics have workers of their own.
 */
export function loadOrt({ background = false }: { background?: boolean } = {}): Promise<Ort> {
  ortPromise ??= (async () => {
    const ort = await import('onnxruntime-web/webgpu')
    const caps = background ? await detectCapabilities() : undefined
    await configureOnnxEnv(
      ort.env,
      caps ? { numThreads: backgroundThreadCount(caps.wasmThreads, caps.hardwareConcurrency) } : {},
    )
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
    const ort = await loadOrt({ background: true })
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
