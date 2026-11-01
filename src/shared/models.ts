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
  /** The model's title in Settings › This device, for naming it in errors ("Lyrics aligner"). */
  title?: string
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

/**
 * How long a download waits for a response, and then for each next chunk, before it counts as not arriving. A request
 * can get no response at all (a stalled proxy or CDN), and the browser then waits for many minutes without an error.
 */
const STALL_SECONDS = 30

/**
 * A failed download's message: with the model's title, a sentence naming it followed by `hint`, the file's URL left
 * to the error's details; without one, `plain`, which callers that name the model keep in their own details.
 */
export function failedMessage(title: string | undefined, hint: string, plain: string): string {
  return title ? `Couldn’t download ${theModel(title)}. ${hint}` : plain
}

/**
 * The error for a download the server answered with error `status`, retryable when the server is in trouble (5xx,
 * 429). Its message is `failedMessage`'s; the status goes into `details` with `where` (the file's URL, say). A refusal
 * (401, 403) is most likely a network that blocks the file's host (from `where.url`); any other status most likely
 * means this build asks for a file that has moved.
 */
export function downloadStatusError(
  status: number,
  title: string | undefined,
  plain: string,
  where: Record<string, unknown>,
): JobError {
  const serverTrouble = status >= 500 || status === 429
  const host = typeof where.url === 'string' && URL.canParse(where.url) ? new URL(where.url).hostname : ''
  const hint = serverTrouble
    ? 'The server is having trouble. Try again in a few minutes.'
    : status === 401 || status === 403
      ? `The server refused the file. If your network blocks ${host || 'model downloads'}, try another network.`
      : 'The server didn’t send the file. Reload the page to get the latest MV Studio, then try again.'
  return new JobError('model-load', failedMessage(title, hint, plain), {
    retryable: serverTrouble,
    details: { ...where, status },
  })
}

/** The error for a download that stopped arriving: a network error, so the job's Try again applies. */
function notArriving(file: ModelFile, title: string | undefined): JobError {
  const download = title ? `The download of ${theModel(title)}` : 'The model download'
  return new JobError('network', `${download} isn’t arriving. Check your connection and try again.`, {
    details: { url: file.url, seconds: STALL_SECONDS },
  })
}

/**
 * Downloads (or reads from cache) one file with streaming progress. The download stage is reported as the request
 * starts, before any bytes, and a download that gets no bytes for `STALL_SECONDS` is aborted (`notArriving`).
 */
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

  onProgress?.({ stage: 'download', fraction: 0, bytesLoaded: 0, bytesTotal: file.bytes, file: fileKey })
  const stall = new AbortController()
  // Counted in one-second ticks rather than by the clock, so time the worker spends blocked (starting another
  // model's session, say) does not count as waiting: after a block, a repeating timer fires once, not once a second.
  let quiet = 0
  const ticks = setInterval(() => {
    if (++quiet >= STALL_SECONDS) stall.abort()
  }, 1000)
  const failed = (error: unknown) => {
    if (signal?.aborted) return new JobError('cancelled', 'Cancelled', { cause: error })
    if (stall.signal.aborted) return notArriving(file, options.title)
    return new JobError(
      'network',
      failedMessage(
        options.title,
        'Check your connection and try again.',
        `Couldn’t download model file ${file.url}`,
      ),
      { cause: error, details: { url: file.url } },
    )
  }

  const chunks: Uint8Array[] = []
  let loaded = 0
  try {
    let response: Response
    try {
      response = await fetch(file.url, {
        mode: 'cors',
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
      })
    } catch (error) {
      throw failed(error)
    }
    quiet = 0
    if (!response.ok) {
      const { status } = response
      throw downloadStatusError(status, options.title, `Model download failed (${status}) for ${file.url}`, {
        url: file.url,
      })
    }

    const total = Number(response.headers.get('content-length')) || file.bytes
    try {
      const reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          quiet = 0
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
    } catch (error) {
      throw failed(error)
    }
  } finally {
    clearInterval(ticks)
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
      throw new JobError(
        'model-load',
        failedMessage(
          options.title,
          'The file that arrived was damaged. Try again.',
          `Checksum mismatch for ${file.url}`,
        ),
        { details: { url: file.url, expected: file.sha256, actual } },
      )
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
