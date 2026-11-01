/**
 * MediaPipe runtime loading for the vision workers. Transformers.js loading is shared (src/shared/transformers.ts).
 * Kept apart from the model registry so main-thread code that only needs descriptors does not bundle the runtimes.
 */
import { FilesetResolver } from '@mediapipe/tasks-vision'
import { fetchModelFile, type ModelDescriptor } from '../../shared/models.ts'
import { JobError } from '../../shared/jobs.ts'
import { downloadProgress } from '../../shared/transformers.ts'
import { visionError } from '../errors.ts'
import { MEDIAPIPE_WASM_BASE } from './models.ts'
import { blockTelemetry } from './telemetry.ts'
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
  return new Uint8Array(await fetchModelFile(file, { onProgress: downloadProgress(model.name) }))
}

/**
 * Creates a MediaPipe task from the ES-module WASM build (works in module workers).
 * MediaPipe clears `self.ModuleFactory` after creating each task, and re-importing the
 * loader is a cached no-op, so the factory is restored before every creation.
 * Every task logs its usage to Google through this context's `fetch` (see telemetry.ts), so that is blocked first.
 */
export async function createMediaPipeTask<T>(create: (fileset: WasmFileset) => Promise<T>): Promise<T> {
  blockTelemetry()
  const { fileset, factory } = await loadMediaPipeRuntime()
  const g = globalThis as { ModuleFactory?: unknown }
  g.ModuleFactory ??= factory
  try {
    return await create(fileset)
  } catch (err) {
    throw visionError(err, 'model-load')
  }
}
