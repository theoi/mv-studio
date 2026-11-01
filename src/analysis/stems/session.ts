import type * as OrtWeb from 'onnxruntime-web/webgpu'
import { DEMUCS_MODEL, MODEL_TITLES } from '../models.ts'
import { loadOrt } from '../ort.ts'
import { JobError, type JobProgress } from '../../shared/jobs.ts'
import {
  downloadingModel,
  loadModelFiles,
  modelBytes,
  theModel,
  type ModelDevice,
} from '../../shared/models.ts'
import { SEGMENT, type DemucsModel } from './demucs.ts'
import { stemsOutOfMemory } from './worker-api.ts'

/** HTDemucs session on WebGPU (with WASM fallback for unsupported nodes) or multithreaded WASM. */
export async function createDemucsModel(options: {
  device: ModelDevice
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
}): Promise<{ model: DemucsModel; device: ModelDevice }> {
  const ort = await loadOrt()
  const files = await loadModelFiles(DEMUCS_MODEL, {
    signal: options.signal,
    title: MODEL_TITLES.stems,
    onProgress: (p) =>
      options.onProgress?.({
        ...p,
        stage: 'download',
        message: downloadingModel(MODEL_TITLES.stems, modelBytes(DEMUCS_MODEL)),
      }),
  })
  let session: OrtWeb.InferenceSession
  try {
    session = await ort.InferenceSession.create(new Uint8Array(files.model), {
      executionProviders: options.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    throw (
      stemsOutOfMemory(error) ??
      new JobError('model-load', `Couldn’t start ${theModel(MODEL_TITLES.stems)}`, { cause: error })
    )
  }
  const [mixName, specName] = session.inputNames as [string, string]
  const model: DemucsModel = {
    async run(mix, spec) {
      const feeds = {
        [mixName]: new ort.Tensor('float32', mix, [1, 2, SEGMENT]),
        [specName]: new ort.Tensor('float32', spec, [1, 4, 2048, spec.length / (4 * 2048)]),
      }
      const out = await session.run(feeds)
      Object.values(feeds).forEach((t) => t.dispose())
      const tensors = Object.values(out)
      const freq = tensors.find((t) => t.dims.length === 5)
      const time = tensors.find((t) => t.dims.length === 4)
      if (!freq || !time)
        throw new JobError('internal', `Unexpected result from ${theModel(MODEL_TITLES.stems)}`)
      // CPU outputs are fresh arrays copied out of the WASM heap, so they stay valid after dispose. Not copying them
      // again (and reusing the spectrogram buffer) lowered the browser's peak by 0.13 to 0.22 GB on 3- to 5-minute
      // songs.
      const result = { x: freq.data as Float32Array, xt: time.data as Float32Array }
      tensors.forEach((t) => t.dispose())
      return result
    },
  }
  return { model, device: options.device }
}
