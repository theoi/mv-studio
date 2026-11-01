/**
 * Shared model loader: every ML model downloads through here so caching, download progress, thread counts and
 * device selection are consistent across audio, vision and director features.
 *
 * Fetches use mode 'cors' with credentials omitted, which works under COEP credentialless and with the Hugging Face
 * and Google CDNs (the pilot verified huggingface.co resolve URLs). Models without CDN CORS are self-hosted under
 * public/models/ and referenced with a base-relative URL (see modelUrl()).
 */
import { detectCapabilities, type RuntimeCapabilities } from './capabilities.ts'
import { JobError, type JobProgress } from './jobs.ts'

export interface ModelFile {
  url: string
  /** Optional integrity check (hex). Verified after download, before caching. */
  sha256?: string
  /** Expected size, used for progress when the server omits Content-Length. */
  bytes?: number
  /**
   * URLs this file was cached under before (e.g. before its URL was pinned to a revision). A copy cached there whose
   * bytes match `sha256` moves to `url` instead of downloading again.
   */
  formerUrls?: string[]
}

export interface ModelDescriptor {
  /** Stable id, e.g. 'beat-this-small'. Also listed in THIRD_PARTY_NOTICES.md. */
  id: string
  name: string
  /** SPDX id or license name. Must permit commercial use. */
  license: string
  /** Where the model comes from (model card URL). */
  homepage: string
  files: Record<string, ModelFile>
}

export interface ModelLoadOptions {
  signal?: AbortSignal
  onProgress?: (progress: JobProgress & { file?: string }) => void
  /** Skip the cache read (still writes). */
  forceDownload?: boolean
}

export type ModelDevice = 'webgpu' | 'wasm'

/**
 * A model's name inside a sentence, from its title in Settings › This device ("Stem separator" gives "the stem
 * separator"). Titles are sentence case with no proper nouns, so lowercasing them is safe.
 */
export const theModel = (title: string) => `the ${title.toLowerCase()}`

/** A model's progress line while it downloads, the first time: "Downloading the stem separator (181 MB, once)". */
export function downloadingModel(title: string, bytes: number): string {
  const size = bytes < 1e6 ? 'under 1 MB' : `${Math.round(bytes / 1e6)} MB`
  return `Downloading ${theModel(title)} (${size}, once)`
}

/** Total size of a model's files. */
export const modelBytes = (model: ModelDescriptor) =>
  Object.values(model.files).reduce((sum, f) => sum + (f.bytes ?? 0), 0)

const CACHE_NAME = 'mv-studio-models-v1'

/** Resolves a self-hosted model path against the app base, e.g. modelUrl('models/beat-this/model.onnx'). */
export function modelUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), new URL(import.meta.env.BASE_URL, globalThis.location?.href)).href
}

async function openCache(): Promise<Cache | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return undefined
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function writeCache(cache: Cache, url: string, buffer: ArrayBuffer): Promise<boolean> {
  try {
    await cache.put(
      url,
      new Response(buffer.slice(0), { headers: { 'content-type': 'application/octet-stream' } }),
    )
    return true
  } catch (error) {
    // A full cache must not fail the load; the model just downloads again next time.
    console.warn('Model cache write failed', error)
    return false
  }
}

/** A copy of `file` cached under one of its former URLs, moved to its URL. Only bytes with its checksum count. */
async function movedFormerCopy(cache: Cache, file: ModelFile): Promise<ArrayBuffer | undefined> {
  if (!file.sha256) return undefined
  for (const url of file.formerUrls ?? []) {
    const hit = await cache.match(url)
    if (!hit) continue
    const buf = await hit.arrayBuffer()
    if ((await sha256Hex(buf)) !== file.sha256.toLowerCase()) continue
    if (await writeCache(cache, file.url, buf)) await cache.delete(url)
    return buf
  }
  return undefined
}

/** Downloads (or reads from cache) one file with streaming progress. */
export async function fetchModelFile(
  file: ModelFile,
  options: ModelLoadOptions & { fileKey?: string } = {},
): Promise<ArrayBuffer> {
  const { signal, onProgress, fileKey } = options
  const cache = await openCache()
  if (cache && !options.forceDownload) {
    const hit = await cache.match(file.url)
    const buf = hit ? await hit.arrayBuffer() : await movedFormerCopy(cache, file)
    if (buf) {
      onProgress?.({
        stage: 'cached',
        fraction: 1,
        bytesLoaded: buf.byteLength,
        bytesTotal: buf.byteLength,
        file: fileKey,
      })
      return buf
    }
  }

  let response: Response
  try {
    response = await fetch(file.url, { mode: 'cors', credentials: 'omit', signal })
  } catch (error) {
    if (signal?.aborted) throw new JobError('cancelled', 'Cancelled', { cause: error })
    throw new JobError('network', `Could not download model file ${file.url}`, { cause: error })
  }
  if (!response.ok) {
    throw new JobError('model-load', `Model download failed (${response.status}) for ${file.url}`, {
      retryable: response.status >= 500 || response.status === 429,
    })
  }

  const total = Number(response.headers.get('content-length')) || file.bytes
  const chunks: Uint8Array[] = []
  let loaded = 0
  const reader = response.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.({
        stage: 'download',
        bytesLoaded: loaded,
        bytesTotal: total,
        fraction: total ? Math.min(1, loaded / total) : undefined,
        file: fileKey,
      })
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer())
    chunks.push(buf)
    loaded = buf.byteLength
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  const buffer = out.buffer

  if (file.sha256) {
    const actual = await sha256Hex(buffer)
    if (actual !== file.sha256.toLowerCase())
      throw new JobError('model-load', `Checksum mismatch for ${file.url}`, {
        details: { expected: file.sha256, actual },
      })
  }
  if (cache) await writeCache(cache, file.url, buffer)
  return buffer
}

/** Downloads every file of a model, reporting combined progress. */
export async function loadModelFiles(
  model: ModelDescriptor,
  options: ModelLoadOptions = {},
): Promise<Record<string, ArrayBuffer>> {
  const entries = Object.entries(model.files)
  const expected = entries.reduce((n, [, f]) => n + (f.bytes ?? 0), 0)
  const loadedByFile = new Map<string, number>()
  const result: Record<string, ArrayBuffer> = {}
  for (const [key, file] of entries) {
    result[key] = await fetchModelFile(file, {
      ...options,
      fileKey: key,
      onProgress: (p) => {
        loadedByFile.set(key, p.bytesLoaded ?? 0)
        const loaded = [...loadedByFile.values()].reduce((a, b) => a + b, 0)
        options.onProgress?.({
          ...p,
          message: `Downloading ${model.name}`,
          bytesLoaded: loaded,
          bytesTotal: expected || undefined,
          fraction: expected ? Math.min(1, loaded / expected) : p.fraction,
        })
      },
    })
  }
  return result
}

export const modelCache = {
  async has(url: string): Promise<boolean> {
    return (await (await openCache())?.match(url)) !== undefined
  },
  async remove(url: string): Promise<void> {
    await (await openCache())?.delete(url)
  },
  async clear(): Promise<void> {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME)
  },
  /** Approximate bytes used by cached model files. */
  async usage(): Promise<{ entries: number; bytes: number }> {
    const cache = await openCache()
    if (!cache) return { entries: 0, bytes: 0 }
    const keys = await cache.keys()
    let bytes = 0
    for (const req of keys) {
      const res = await cache.match(req)
      bytes +=
        Number(res?.headers.get('content-length')) || (res ? (await res.clone().arrayBuffer()).byteLength : 0)
    }
    return { entries: keys.length, bytes }
  },
}

/** WebGPU when available (and not disabled), otherwise multithreaded WASM. */
export function preferredDevice(caps: RuntimeCapabilities, allowWebGpu = true): ModelDevice {
  return allowWebGpu && caps.webgpu.available ? 'webgpu' : 'wasm'
}

/** The parts of onnxruntime-web's `env` (also Transformers.js `env.backends.onnx`) that we configure. */
export interface OnnxEnvLike {
  wasm: { numThreads?: number; proxy?: boolean; wasmPaths?: unknown }
}

/**
 * Applies the shared thread policy to an onnxruntime-web env. Call before creating the first session in that realm
 * (ORT fixes its thread pool at first init).
 */
export async function configureOnnxEnv(
  env: OnnxEnvLike,
  options: { numThreads?: number } = {},
): Promise<number> {
  const caps = await detectCapabilities()
  const threads = options.numThreads ?? caps.wasmThreads
  env.wasm.numThreads = threads
  env.wasm.proxy = false
  return threads
}
