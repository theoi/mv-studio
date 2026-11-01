import { afterEach, expect, it, vi } from 'vitest'
import * as T from '@huggingface/transformers'
import { loadWhisperPipeline } from '../../../src/analysis/lyrics/whisperModel.ts'
import { WHISPER_MODELS, whisperFileUrls } from '../../../src/analysis/models.ts'
import { sharedFetch } from '../../../src/shared/transformers.ts'

// What loadTransformers() sets that applies here: no other cache or source, every fetch through the model loader.
const env = T.env as typeof T.env & { useFSCache: boolean }
env.allowLocalModels = false
env.useBrowserCache = false
env.useFSCache = false
env.fetch = sharedFetch

afterEach(() => vi.unstubAllGlobals())

/** Serves small stand-ins for the JSON files and 404 for the graphs, recording every URL requested. */
function serve(): string[] {
  const urls: string[] = []
  const json: Record<string, object> = {
    'config.json': { model_type: 'whisper', architectures: ['WhisperForConditionalGeneration'] },
    'preprocessor_config.json': { feature_extractor_type: 'WhisperFeatureExtractor' },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const name = url.slice(url.lastIndexOf('/') + 1)
      if (!name.endsWith('.json')) return new Response(null, { status: 404 })
      return new Response(JSON.stringify(json[name] ?? {}))
    }),
  )
  return urls
}

it.each(Object.entries(WHISPER_MODELS))(
  'Whisper %s loads every file at its pinned revision, the graphs at the URLs the estimate checks',
  async (_, spec) => {
    const urls = serve()
    // The stand-ins are not a working model; what matters is what was asked for. ONNX Runtime for Node has no 'wasm'.
    await loadWhisperPipeline(T, spec, 'cpu').catch(() => undefined)
    const graphs = whisperFileUrls(spec)
    await vi.waitFor(() => expect(urls).toEqual(expect.arrayContaining(graphs)))
    const pinned = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/`
    expect(urls.filter((u) => !u.startsWith(pinned))).toEqual([])
    expect(urls).toEqual(
      expect.arrayContaining(
        ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json'].map(
          (f) => pinned + f,
        ),
      ),
    )
  },
)
