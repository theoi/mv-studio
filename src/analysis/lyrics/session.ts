import { MODEL_TITLES, WAV2VEC2_MODEL } from '../models.ts'
import { loadOrt } from '../ort.ts'
import { JobError, type JobProgress } from '../../shared/jobs.ts'
import { loadModelFiles, theModel } from '../../shared/models.ts'
import { ctcVocabulary, type CtcVocabulary } from './align.ts'
import { ALIGNER_STARTING, alignerLoadProgress } from './loadProgress.ts'
import type { CtcModel } from './wav2vec2.ts'

/** The wav2vec2 aligner on WASM threads (its 8-bit graph has no WebGPU kernels). */
export async function createCtcModel(
  options: { signal?: AbortSignal; onProgress?: (progress: JobProgress) => void } = {},
): Promise<{ model: CtcModel; vocab: CtcVocabulary }> {
  const ort = await loadOrt()
  const report = options.onProgress ?? (() => undefined)
  const files = await loadModelFiles(WAV2VEC2_MODEL, {
    signal: options.signal,
    onProgress: alignerLoadProgress(report),
  })
  report(ALIGNER_STARTING)
  const vocab = ctcVocabulary(JSON.parse(new TextDecoder().decode(files.vocab)) as Record<string, number>)
  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>
  try {
    session = await ort.InferenceSession.create(new Uint8Array(files.model), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (error) {
    throw new JobError('model-load', `Could not start ${theModel(MODEL_TITLES.aligner)}`, { cause: error })
  }
  const inputName = session.inputNames[0] as string
  const model: CtcModel = {
    async run(input) {
      const tensor = new ort.Tensor('float32', input, [1, input.length])
      const out = await session.run({ [inputName]: tensor })
      tensor.dispose()
      const logits = Object.values(out)[0]
      if (!logits || logits.dims.length !== 3)
        throw new JobError('internal', 'Unexpected lyrics aligner output')
      const result = {
        logits: Float32Array.from(logits.data as Float32Array),
        frames: logits.dims[1] as number,
        vocab: logits.dims[2] as number,
      }
      logits.dispose()
      return result
    },
  }
  return { model, vocab }
}
