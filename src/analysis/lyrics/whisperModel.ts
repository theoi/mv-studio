/** Whisper through Transformers.js as a `Transcriber`. */
import { loadTransformers } from '../../shared/transformers.ts'
import type { ModelDevice } from '../../shared/models.ts'
import type { WhisperModelSpec } from '../models.ts'
import type { TranscriptSegment, Transcriber } from './whisper.ts'

interface AsrChunk {
  timestamp: [number, number | null]
  text: string
}

function asChunks(out: unknown, seconds: number): AsrChunk[] {
  const result = (Array.isArray(out) ? out[0] : out) as { text?: unknown; chunks?: unknown } | undefined
  if (Array.isArray(result?.chunks)) return result.chunks as AsrChunk[]
  return typeof result?.text === 'string' ? [{ timestamp: [0, seconds], text: result.text }] : []
}

/**
 * Loads a Whisper model. Each chunk gets a token budget proportional to its length, which stops the repetition
 * loops Whisper can fall into on singing well before its 448-token limit.
 */
export async function createWhisperTranscriber(
  spec: WhisperModelSpec,
  device: ModelDevice,
): Promise<Transcriber & { dispose(): Promise<unknown> }> {
  const T = await loadTransformers()
  const asr = await T.pipeline('automatic-speech-recognition', spec.repo, {
    revision: spec.revision,
    device,
    dtype: spec.dtype,
  })
  const config = asr.model.generation_config as unknown as {
    decoder_start_token_id: number
    lang_to_id: Record<string, number>
  }
  return {
    async transcribe(pcm, options): Promise<TranscriptSegment[]> {
      const seconds = pcm.length / 16000
      const out: unknown = await asr(pcm, {
        return_timestamps: true,
        task: 'transcribe',
        language: options.language,
        max_new_tokens: Math.min(440, Math.ceil(seconds * 6) + 16),
      })
      return asChunks(out, seconds).map((c) => ({
        start: c.timestamp[0],
        end: c.timestamp[1] ?? seconds,
        text: c.text,
      }))
    },
    async languageProbabilities(pcm) {
      const { input_features } = (await asr.processor(pcm)) as { input_features: unknown }
      const start = BigInt64Array.from([BigInt(config.decoder_start_token_id)])
      const out = (await asr.model.forward({
        input_features,
        decoder_input_ids: new T.Tensor('int64', start, [1, 1]),
      })) as { logits: { data: Float32Array; dims: number[] } }
      const vocab = out.logits.dims.at(-1) ?? 0
      const last = out.logits.data.subarray(out.logits.data.length - vocab)
      const scores = Object.entries(config.lang_to_id).map(
        ([token, id]) => [token.slice(2, -2), last[id] ?? -Infinity] as const,
      )
      const max = Math.max(...scores.map((s) => s[1]))
      const sum = scores.reduce((a, s) => a + Math.exp(s[1] - max), 0)
      return Object.fromEntries(scores.map(([language, v]) => [language, Math.exp(v - max) / sum]))
    },
    dispose: () => asr.dispose(),
  }
}
