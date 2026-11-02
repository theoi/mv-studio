import type { OnnxBackend, SegmentationBackend, SegmentationRole, VisionBackends } from '../backends.ts'
import {
  createWorkerClient,
  type CallOptions,
  type Transferred,
  type WorkerApi,
} from '../../shared/worker.ts'
import { routeDownloads, type ModelDownload } from '../runtime/downloads.ts'
import type { OnnxWorkerApi } from './onnx.worker.ts'
import type { SegmentationWorkerApi } from './segmentation.worker.ts'

type UnwrapOne<V> = V extends Transferred<infer T> ? T : V
type Unwrap<R> = UnwrapOne<Awaited<R>>

type Methods<Api extends WorkerApi> = {
  [M in keyof Api & string]: (
    args: Parameters<Api[M]>[0],
    options?: CallOptions,
  ) => Promise<Unwrap<ReturnType<Api[M]>>>
}

/**
 * Methods of a worker that starts on the first call. A worker that dies (an uncaught error, a message that cannot
 * be read, or the browser stopping it) is replaced on the next call; calls pending at that moment reject with
 * `worker-crashed` or `out-of-memory`. State the dead worker held (loaded models, unfinished tracks) is lost, so
 * running jobs fail and the user's retry starts fresh. Model downloads a call starts go to `downloads` instead of
 * the call's progress (`routeDownloads`). `release(idleMs)` ends the worker if none of its calls is pending or ended in
 * the last `idleMs`; the next call starts a fresh one.
 */
function lazyWorker<Api extends WorkerApi>(
  create: () => Worker,
  downloads: (d: ModelDownload) => void,
): { client: Methods<Api>; terminate(): void; release(idleMs: number): boolean } {
  const worker = createWorkerClient<Api>(create)
  let used = -Infinity
  const touch = () => {
    used = performance.now()
  }
  const client = new Proxy({} as Methods<Api>, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined
      return (args: unknown, options?: CallOptions) =>
        routeDownloads(
          (onProgress) =>
            worker.call(method as keyof Api & string, args as never, { ...options, onProgress }),
          options?.onProgress,
          downloads,
        ).finally(touch)
    },
  })
  return {
    client,
    terminate: () => worker.terminate(),
    release: (idleMs) => performance.now() - used >= idleMs && worker.release(),
  }
}
export interface WorkerBackends extends VisionBackends {
  release(options?: { idleMs?: number }): boolean
  dispose(): void
}

export function createWorkerBackends(): WorkerBackends {
  const segmentation = new Map<SegmentationRole, ReturnType<typeof lazyWorker<SegmentationWorkerApi>>>()
  let onnx: ReturnType<typeof lazyWorker<OnnxWorkerApi>> | null = null
  const listeners = new Set<(d: ModelDownload) => void>()
  const downloads = (d: ModelDownload) => {
    for (const listener of listeners) listener(d)
  }
  return {
    segmentation(role = 'interactive'): SegmentationBackend {
      let w = segmentation.get(role)
      if (!w) {
        w = lazyWorker<SegmentationWorkerApi>(
          () =>
            new Worker(new URL('./segmentation.worker.ts', import.meta.url), {
              type: 'module',
              name: `vision-segmentation-${role}`,
            }),
          downloads,
        )
        segmentation.set(role, w)
      }
      return w.client
    },
    onnx(): OnnxBackend {
      onnx ??= lazyWorker<OnnxWorkerApi>(
        () =>
          new Worker(new URL('./onnx.worker.ts', import.meta.url), { type: 'module', name: 'vision-onnx' }),
        downloads,
      )
      return onnx.client
    },
    watchDownloads(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    release({ idleMs = 0 } = {}) {
      let none = true
      for (const w of [...segmentation.values(), ...(onnx ? [onnx] : [])])
        if (!w.release(idleMs)) none = false
      return none
    },
    dispose() {
      for (const w of segmentation.values()) w.terminate()
      segmentation.clear()
      onnx?.terminate()
      onnx = null
    },
  }
}
