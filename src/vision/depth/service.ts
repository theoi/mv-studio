import type { OnnxBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { throwIfAborted, visionError } from '../errors.ts'
import { cacheKey, type BlobCache } from '../runtime/cache.ts'
import { decodeContainer, encodeContainer } from '../runtime/container.ts'
import { VISION_MODELS } from '../runtime/models.ts'
import { createProgress, type ProgressFn, type TaskOptions } from '../runtime/tasks.ts'
import type { DepthMap, DepthQuality, Size } from '../types.ts'

export interface DepthRequest {
  mediaId: string
  /** Media time in seconds; 0 (the default) for stills. */
  t?: number
  quality: DepthQuality
  sourceSize: Size
  /** Grabs the frame with its longer side at most `maxSide`. The returned bitmap is consumed. */
  frame: (maxSide: number) => Promise<ImageBitmap>
}

export interface DepthService {
  /**
   * Cached or freshly estimated depth. A preview request may resolve with a full-quality map. Concurrent
   * identical requests share one estimation. The returned map is shared between callers; treat it as immutable.
   */
  get(req: DepthRequest, options?: TaskOptions): Promise<DepthMap>
  /** Best cached map without computing, or null. */
  peek(req: Omit<DepthRequest, 'frame'>): Promise<DepthMap | null>
}

/** Model input short side per quality (multiples of 14, as the ViT patch size requires). */
export const DEPTH_SHORT_SIDE: Readonly<Record<DepthQuality, number>> = { preview: 364, full: 518 }
/** Bumped whenever the stored format or the processing changes in a way that invalidates cached maps. */
export const DEPTH_FORMAT_VERSION = 1
const DEPTH_MODEL = VISION_MODELS.depthAnythingSmall.id

interface DepthMeta {
  version: 1
  width: number
  height: number
  sourceSize: Size
  model: string
  quality: DepthQuality
}

interface SharedTask {
  key: string
  promise: Promise<DepthMap>
  controller: AbortController
  callers: number
  listeners: Set<ProgressFn>
}

export function depthCacheKey(req: { mediaId: string; t?: number }, quality: DepthQuality): string {
  return cacheKey(
    'depth',
    DEPTH_FORMAT_VERSION,
    DEPTH_MODEL,
    quality,
    req.mediaId,
    Math.round((req.t ?? 0) * 1000),
  )
}

export function createDepthService(deps: { onnx: OnnxBackend; cache: BlobCache }): DepthService {
  const { onnx, cache } = deps
  const inflight = new Map<string, SharedTask>()

  // Cache problems never fail a request: a bad or unreadable entry only costs a recompute.
  async function read(key: string): Promise<DepthMap | null> {
    let bytes: Uint8Array | null
    try {
      bytes = await cache.get(key)
    } catch {
      return null
    }
    if (!bytes) return null
    try {
      const { meta, chunks } = await decodeContainer<DepthMeta>(bytes)
      const data = chunks[0]
      if (
        meta.version !== 1 ||
        meta.model !== DEPTH_MODEL ||
        !data ||
        data.length !== meta.width * meta.height
      ) {
        throw new JobError('internal', 'Unexpected depth cache entry')
      }
      return { ...meta, data: data.slice() }
    } catch {
      await cache.delete(key).catch(() => undefined)
      return null
    }
  }

  async function write(key: string, map: DepthMap): Promise<void> {
    const { data, ...rest } = map
    const meta: DepthMeta = { ...rest }
    try {
      await cache.put(key, await encodeContainer(meta, [data], { compress: true }))
    } catch {
      // The map is still valid; the next request recomputes it.
    }
  }

  async function lookup(req: Omit<DepthRequest, 'frame'>): Promise<DepthMap | null> {
    const order: DepthQuality[] = req.quality === 'preview' ? ['full', 'preview'] : ['full']
    for (const quality of order) {
      const map = await read(depthCacheKey(req, quality))
      if (map) return map
    }
    return null
  }

  async function compute(
    req: DepthRequest,
    key: string,
    signal: AbortSignal,
    report: ProgressFn,
  ): Promise<DepthMap> {
    const cached = await lookup(req)
    if (cached) return cached
    throwIfAborted(signal)

    report(0.02, 'loading-frame')
    const shortSide = DEPTH_SHORT_SIDE[req.quality]
    const { width: sw, height: sh } = req.sourceSize
    const maxSide = Math.ceil((shortSide * Math.max(sw, sh)) / Math.min(sw, sh))
    let bitmap: ImageBitmap
    try {
      bitmap = await req.frame(maxSide)
    } catch (err) {
      throw visionError(err, 'decode')
    }
    if (signal.aborted) {
      bitmap.close()
      throwIfAborted(signal)
    }

    report(0.1, 'estimating-depth')
    let raw: { width: number; height: number; data: Uint8Array }
    try {
      raw = await onnx.depth(
        { bitmap, shortSide },
        { signal, transfer: [bitmap], onProgress: (p) => report(0.1 + 0.85 * (p.fraction ?? 0)) },
      )
    } catch (err) {
      throw visionError(err, 'internal')
    }
    throwIfAborted(signal)
    if (!(raw.width > 0 && raw.height > 0) || raw.data.length !== raw.width * raw.height) {
      throw new JobError(
        'internal',
        `Depth output has ${raw.data.length} values for ${raw.width}x${raw.height}`,
      )
    }
    const map: DepthMap = {
      version: 1,
      width: raw.width,
      height: raw.height,
      data: raw.data,
      sourceSize: { width: sw, height: sh },
      model: DEPTH_MODEL,
      quality: req.quality,
    }
    await write(key, map)
    return map
  }

  function start(key: string, req: DepthRequest): SharedTask {
    const listeners = new Set<ProgressFn>()
    const controller = new AbortController()
    const report: ProgressFn = (fraction, stage) => {
      for (const listener of listeners) listener(fraction, stage)
    }
    const promise = compute(req, key, controller.signal, report).finally(() => {
      if (inflight.get(key) === task) inflight.delete(key)
    })
    // Rejections are delivered through join(); once every caller has left nobody observes the result.
    promise.catch(() => undefined)
    const task: SharedTask = { key, controller, callers: 0, listeners, promise }
    inflight.set(key, task)
    return task
  }

  function join(task: SharedTask, options: TaskOptions): Promise<DepthMap> {
    const { signal } = options
    const report = createProgress(options.onProgress)
    task.callers++
    task.listeners.add(report)
    return new Promise<DepthMap>((resolve, reject) => {
      let settled = false
      const leave = () => {
        settled = true
        task.callers--
        task.listeners.delete(report)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (settled) return
        leave()
        if (task.callers === 0) {
          // Detach first so a new request starts fresh instead of joining a computation that is shutting down.
          if (inflight.get(task.key) === task) inflight.delete(task.key)
          task.controller.abort(new JobError('cancelled', 'The task was cancelled.'))
        }
        reject(new JobError('cancelled', 'The task was cancelled.', { cause: signal?.reason }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      task.promise.then(
        (map) => {
          if (settled) return
          leave()
          report(1)
          resolve(map)
        },
        (err: unknown) => {
          if (settled) return
          leave()
          reject(visionError(err, 'internal'))
        },
      )
    })
  }

  return {
    async get(req, options = {}) {
      throwIfAborted(options.signal)
      const { width, height } = req.sourceSize
      if (!(width > 0 && height > 0))
        throw new JobError('invalid-input', `Invalid source size ${width}x${height}`)
      const key = depthCacheKey(req, req.quality)
      const task = inflight.get(depthCacheKey(req, 'full')) ?? inflight.get(key) ?? start(key, req)
      return join(task, options)
    },
    peek(req) {
      return lookup(req)
    },
  }
}
