/**
 * Model runtime loading for the vision workers (MediaPipe tasks, Transformers.js). Kept apart from the model
 * registry so main-thread code that only needs descriptors does not bundle the runtimes.
 */
import type * as Transformers from '@huggingface/transformers'
import { FilesetResolver } from '@mediapipe/tasks-vision'
import { configureOnnxEnv, fetchModelFile, type ModelDescriptor } from '../../shared/models.ts'
import { JobError, type JobProgress } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { MEDIAPIPE_WASM_BASE } from './models.ts'

/**
 * Progress of model downloads started by the current worker call. Workers handle one heavy call at a time,
 * so a single sink is enough; calls set it while they may trigger downloads.
 */
let progressSink: ((p: JobProgress) => void) | null = null

export async function withModelProgress<T>(
  onProgress: ((p: JobProgress) => void) | undefined,
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

function reportDownload(name: string) {
  return (p: JobProgress) => progressSink?.({ ...p, stage: 'download', message: `Downloading ${name}` })
}

// ---------------------------------------------------------------------------------------------------------------
// MediaPipe

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
let mediapipeRuntime: Promise<{ fileset: WasmFileset; factory: unknown }> | null = null

function loadMediaPipeRuntime(): Promise<{ fileset: WasmFileset; factory: unknown }> {
  mediapipeRuntime ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE, true)
    const mod = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown }
    return { fileset, factory: mod.default }
  })().catch((err: unknown) => {
    mediapipeRuntime = null
    throw visionError(err, 'model-load')
  })
  return mediapipeRuntime
}

/** Model bytes through the shared loader (Cache Storage, progress), for MediaPipe's `modelAssetBuffer`. */
export async function mediapipeModel(model: ModelDescriptor): Promise<Uint8Array> {
  const file = model.files.model
  if (!file) throw new JobError('internal', `${model.name} has no model file`)
  return new Uint8Array(await fetchModelFile(file, { onProgress: reportDownload(model.name) }))
}

/**
 * Creates a MediaPipe task from the ES-module WASM build (works in module workers).
 * MediaPipe clears `self.ModuleFactory` after creating each task, and re-importing the
 * loader is a cached no-op, so the factory is restored before every creation.
 */
export async function createMediaPipeTask<T>(create: (fileset: WasmFileset) => Promise<T>): Promise<T> {
  const { fileset, factory } = await loadMediaPipeRuntime()
  const g = globalThis as { ModuleFactory?: unknown }
  g.ModuleFactory ??= factory
  try {
    return await create(fileset)
  } catch (err) {
    throw visionError(err, 'model-load')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transformers.js

let transformersPromise: Promise<typeof Transformers> | null = null

/**
 * Transformers.js fetches models itself; routing its fetch through the shared loader gives one cache, one progress
 * surface and integrity handling for every model. Its optional-file probing relies on real HTTP statuses.
 */
async function sharedFetch(input: string | URL): Promise<Response> {
  const url = String(input)
  try {
    const buf = await fetchModelFile({ url }, { onProgress: reportDownload(url.split('/').pop() ?? url) })
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength) } })
  } catch (err) {
    const status = err instanceof JobError ? /\((\d{3})\)/.exec(err.message)?.[1] : undefined
    if (status) return new Response(null, { status: Number(status) })
    throw err
  }
}

/** Imports Transformers.js once and applies the shared runtime settings (threads, fetch, no second cache). */
export function loadTransformers(): Promise<typeof Transformers> {
  transformersPromise ??= import('@huggingface/transformers').then(async (T) => {
    const onnx = T.env.backends.onnx
    if (onnx.wasm) await configureOnnxEnv({ wasm: onnx.wasm })
    T.env.allowLocalModels = false
    T.env.useBrowserCache = false
    T.env.fetch = sharedFetch
    return T
  })
  return transformersPromise
}
