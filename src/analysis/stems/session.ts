import type * as OrtWeb from 'onnxruntime-web/wasm'
import { DEMUCS_MODEL } from '../models.ts'
import { JobError, type JobProgress } from '../../shared/jobs.ts'
import { configureOnnxEnv, loadModelFiles, type ModelDevice } from '../../shared/models.ts'
import { SEGMENT, type DemucsModel } from './demucs.ts'

type Ort = typeof OrtWeb

/**
 * HTDemucs session on WebGPU (with WASM fallback for unsupported nodes) or multithreaded WASM. The WASM-only ORT
 * build is half the download, so it is used whenever WebGPU is not.
 */
export async function createDemucsModel(options: {
  device: ModelDevice
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
}): Promise<{ model: DemucsModel; device: ModelDevice }> {
  const ort: Ort =
    options.device === 'webgpu'
      ? await import('onnxruntime-web/webgpu')
      : await import('onnxruntime-web/wasm')
  await configureOnnxEnv(ort.env)
  const files = await loadModelFiles(DEMUCS_MODEL, {
    signal: options.signal,
    onProgress: (p) =>
      options.onProgress?.({ ...p, stage: 'download', message: 'Downloading the stem model (181 MB, once)' }),
  })
  let session: OrtWeb.InferenceSession
  try {
    session = await ort.InferenceSession.create(new Uint8Array(files.model), {
      executionProviders: options.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    throw new JobError('model-load', 'Could not start the stem separation model', { cause: error })
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
      if (!freq || !time) throw new JobError('internal', 'Unexpected stem model outputs')
      const result = {
        x: Float32Array.from(freq.data as Float32Array),
        xt: Float32Array.from(time.data as Float32Array),
      }
      tensors.forEach((t) => t.dispose())
      return result
    },
  }
  return { model, device: options.device }
}
