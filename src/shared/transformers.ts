/**
 * Transformers.js for every area's workers, set up once per realm: models download through the shared loader (one
 * Cache Storage cache, progress, integrity), ONNX Runtime uses the shared thread policy, and its WASM comes from
 * this app's own build instead of a CDN, so the app ships one set of ONNX Runtime binaries.
 */
import type * as Transformers from '@huggingface/transformers'
// The asyncify build is the one Transformers.js selects (WASM and WebGPU backends). package.json pins
// onnxruntime-web to the exact version Transformers.js imports, so these files match its JS glue.
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { JobError, type JobProgress } from './jobs.ts'
import { configureOnnxEnv, fetchModelFile, type ModelFile } from './models.ts'

/** Progress of one file a model loads: `file` names it, `cached` when it was read from the model cache. */
export type ModelFileProgress = JobProgress & { file: string; cached: boolean }

/**
 * Download progress of the current worker call. Workers handle one heavy call at a time, so a single sink per realm
 * is enough; calls set it while they may trigger downloads.
 */
let progressSink: ((p: ModelFileProgress) => void) | null = null

/** Reports model downloads started while `run` runs (by Transformers.js or `downloadProgress`) to `onProgress`. */
export async function withModelProgress<T>(
  onProgress: ((p: ModelFileProgress) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = progressSink
  progressSink = onProgress ?? null
  try {
    return await run()
  } finally {
    progressSink = previous
  }
}

/** Progress callback for downloading `name` inside the current `withModelProgress` call. */
export function downloadProgress(name: string): (p: JobProgress) => void {
  return (p) =>
    progressSink?.({
      ...p,
      stage: 'download',
      message: `Downloading ${name}`,
      file: name,
      cached: p.stage === 'cached',
    })
}

/** The revision each Hugging Face repo loads at, by repo id (see `pinRevision`). */
const pinnedRevisions = new Map<string, string>()

/**
 * Loads every file of Hugging Face repo `repo` from `revision`, also where Transformers.js asks for its `main`
 * branch: in 4.3, `pipeline()` and `AutoTokenizer.from_pretrained()` look up which files a model has at `main`,
 * whatever revision they are given.
 */
export function pinRevision(repo: string, revision: string): void {
  pinnedRevisions.set(repo, revision)
}

function pinnedUrl(url: string): string {
  const repo = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\//.exec(url)?.[1]
  const revision = repo && pinnedRevisions.get(repo)
  return revision ? url.replace('/resolve/main/', `/resolve/${revision}/`) : url
}

/** Files Transformers.js may request that this realm knows more about (checksum, former cache keys), by URL. */
const knownFiles = new Map<string, ModelFile>()

/** Makes `sharedFetch` verify these files and reuse copies cached under their former URLs. */
export function registerModelFiles(files: Iterable<ModelFile>): void {
  for (const file of files) knownFiles.set(file.url, file)
}

/**
 * `fetch` for Transformers.js that goes through the shared model loader, at pinned revisions (`pinRevision`). Its
 * optional-file probing relies on real HTTP statuses, so loader errors that carry one become responses with that
 * status.
 */
export async function sharedFetch(input: string | URL): Promise<Response> {
  const url = pinnedUrl(String(input))
  try {
    const file = knownFiles.get(url) ?? { url }
    const buf = await fetchModelFile(file, { onProgress: downloadProgress(url.split('/').pop() ?? url) })
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength) } })
  } catch (err) {
    const status = err instanceof JobError ? /\((\d{3})\)/.exec(err.message)?.[1] : undefined
    if (status) return new Response(null, { status: Number(status) })
    throw err
  }
}

let transformersPromise: Promise<typeof Transformers> | null = null

/** Imports Transformers.js once and applies the shared runtime settings (threads, WASM location, fetch, no second cache). */
export function loadTransformers(): Promise<typeof Transformers> {
  transformersPromise ??= import('@huggingface/transformers')
    .then(async (T) => {
      const onnx = T.env.backends.onnx
      if (onnx.wasm) {
        await configureOnnxEnv({ wasm: onnx.wasm })
        onnx.wasm.wasmPaths = {
          mjs: new URL(ortMjsUrl, self.location.href).href,
          wasm: new URL(ortWasmUrl, self.location.href).href,
        }
      }
      T.env.allowLocalModels = false
      T.env.useBrowserCache = false
      T.env.fetch = sharedFetch
      return T
    })
    .catch((err: unknown) => {
      transformersPromise = null
      throw err
    })
  return transformersPromise
}
