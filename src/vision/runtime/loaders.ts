/**
 * MediaPipe runtime loading for the vision workers. Transformers.js loading is shared (src/shared/transformers.ts).
 * Kept apart from the model registry so main-thread code that only needs descriptors does not bundle the runtimes.
 */
import { FilesetResolver } from '@mediapipe/tasks-vision'
import { fetchModelFile, type ModelDescriptor } from '../../shared/models.ts'
import { JobError } from '../../shared/jobs.ts'
import { downloadProgress } from '../../shared/transformers.ts'
import { downloadFailed, startFailed } from '../errors.ts'
import { MEDIAPIPE_WASM_BASE, type VisionModel } from './models.ts'
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
    throw err
  })
  return mediapipeRuntime
}

/** Model bytes of `name` through the shared loader (Cache Storage, progress), for MediaPipe's `modelAssetBuffer`. */
export async function mediapipeModel(model: ModelDescriptor, name: VisionModel): Promise<Uint8Array> {
  const file = model.files.model
  if (!file) throw new JobError('internal', `${model.name} has no model file`)
  const progress = downloadProgress(file.url.slice(file.url.lastIndexOf('/') + 1))
  try {
    return new Uint8Array(await fetchModelFile(file, { onProgress: progress }))
  } catch (err) {
    throw downloadFailed(name, err)
  }
}

/**
 * Creates a MediaPipe task of model `name` from the ES-module WASM build (works in module workers).
 * MediaPipe clears `self.ModuleFactory` after creating each task, and re-importing the
 * loader is a cached no-op, so the factory is restored before every creation.
 * Every task logs its usage to Google through this context's `fetch` (see telemetry.ts), so that is blocked first.
 */
export async function createMediaPipeTask<T>(
  name: VisionModel,
  create: (fileset: WasmFileset) => Promise<T>,
): Promise<T> {
  blockTelemetry()
  let runtime: { fileset: WasmFileset; factory: unknown }
  try {
    runtime = await loadMediaPipeRuntime()
  } catch (err) {
    throw downloadFailed(name, err)
  }
  const g = globalThis as { ModuleFactory?: unknown }
  g.ModuleFactory ??= runtime.factory
  try {
    return await create(runtime.fileset)
  } catch (err) {
    throw startFailed(name, err)
  }
}
