import type { EmbeddingModel, OnnxBackend } from '../backends.ts'
import type { ClipMatch, ClipVisionIndex, MatchQuery, Mood } from '../types.ts'
import { meanVector } from './embeddings.ts'
import { MOOD_PROMPTS, queryVariants, REFERENCE_PROMPTS } from './prompts.ts'
import { rankClips, type RankInput } from './ranking.ts'

export interface MatchOptions {
  weights?: RankInput['weights']
  signal?: AbortSignal
}

export interface FootageMatcher {
  readonly model: EmbeddingModel
  /**
   * Clips ordered by fit to a lyric line / section (text, mood, energy), each with its best
   * range. Indexes built with another embedding model are ignored; re-index them.
   */
  rank(library: readonly ClipVisionIndex[], query: MatchQuery, options?: MatchOptions): Promise<ClipMatch[]>
  /** Same as `rank` for many queries, embedding all texts in one batch. */
  rankAll(
    library: readonly ClipVisionIndex[],
    queries: readonly MatchQuery[],
    options?: MatchOptions,
  ): Promise<ClipMatch[][]>
  /** Hubness reference for `indexClip`. */
  referenceVectors(): Promise<Float32Array[]>
  /** Mean embedding of a set of captions describing one concept (cached); undefined for no captions. */
  promptVector(prompts: readonly string[], signal?: AbortSignal): Promise<Float32Array | undefined>
}

export function createFootageMatcher(deps: { onnx: OnnxBackend; model: EmbeddingModel }): FootageMatcher {
  const { onnx, model } = deps
  const textCache = new Map<string, Promise<Float32Array>>()
  let references: Promise<Float32Array[]> | null = null

  /** Embeds texts not cached yet in one call; returns vectors in input order. */
  const embed = async (texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    const missing = [...new Set(texts.filter((t) => !textCache.has(t)))]
    if (missing.length) {
      const batch = onnx.embedTexts({ texts: missing, model }, signal ? { signal } : {})
      missing.forEach((text, i) => {
        const p = batch.then((r) => r.data.slice(i * r.dim, (i + 1) * r.dim))
        p.catch(() => textCache.delete(text))
        textCache.set(text, p)
      })
    }
    return Promise.all(texts.map((t) => textCache.get(t)!))
  }

  const vectorFor = async (texts: readonly string[], signal?: AbortSignal) =>
    texts.length ? meanVector(await embed(texts, signal)) : undefined

  const rankAll: FootageMatcher['rankAll'] = async (library, queries, options = {}) => {
    const compatible = library.filter((c) => c.model === model)
    const allTexts = queries.flatMap((q) => [
      ...(q.text ? queryVariants(q.text) : []),
      ...(q.mood ? MOOD_PROMPTS[q.mood] : []),
    ])
    await embed(allTexts, options.signal)
    const moodVectors = new Map<Mood, Float32Array | undefined>()
    return Promise.all(
      queries.map(async (q) => {
        const textVector = q.text ? await vectorFor(queryVariants(q.text)) : undefined
        let moodVector: Float32Array | undefined
        if (q.mood) {
          if (!moodVectors.has(q.mood)) moodVectors.set(q.mood, await vectorFor(MOOD_PROMPTS[q.mood]))
          moodVector = moodVectors.get(q.mood)
        }
        return rankClips({
          library: compatible,
          ...(textVector ? { textVector } : {}),
          ...(moodVector ? { moodVector } : {}),
          ...(q.mood ? { mood: q.mood } : {}),
          ...(q.energy !== undefined ? { energy: q.energy } : {}),
          ...(q.duration !== undefined ? { duration: q.duration } : {}),
          ...(options.weights ? { weights: options.weights } : {}),
        })
      }),
    )
  }

  return {
    model,
    async rank(library, query, options) {
      return (await rankAll(library, [query], options))[0]!
    },
    rankAll,
    promptVector: vectorFor,
    referenceVectors() {
      references ??= embed(REFERENCE_PROMPTS).catch((err: unknown) => {
        references = null
        throw err
      })
      return references
    },
  }
}
