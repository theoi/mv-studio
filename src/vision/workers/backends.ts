import type { OnnxBackend, SegmentationBackend, SegmentationRole, VisionBackends } from '../backends.ts'
import {
  createWorkerClient,
  type CallOptions,
  type Transferred,
  type WorkerApi,
} from '../../shared/worker.ts'
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
 * running jobs fail and the user's retry starts fresh.
 */
function lazyWorker<Api extends WorkerApi>(
  create: () => Worker,
): { client: Methods<Api>; terminate(): void } {
  const worker = createWorkerClient<Api>(create)
  const client = new Proxy({} as Methods<Api>, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined
      return (args: unknown, options?: CallOptions) =>
        worker.call(method as keyof Api & string, args as never, options)
    },
  })
  return { client, terminate: () => worker.terminate() }
}
export interface WorkerBackends extends VisionBackends {
  dispose(): void
}

export function createWorkerBackends(): WorkerBackends {
  const segmentation = new Map<SegmentationRole, ReturnType<typeof lazyWorker<SegmentationWorkerApi>>>()
  let onnx: ReturnType<typeof lazyWorker<OnnxWorkerApi>> | null = null
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
        )
        segmentation.set(role, w)
      }
      return w.client
    },
    onnx(): OnnxBackend {
      onnx ??= lazyWorker<OnnxWorkerApi>(
        () =>
          new Worker(new URL('./onnx.worker.ts', import.meta.url), { type: 'module', name: 'vision-onnx' }),
      )
      return onnx.client
    },
    dispose() {
      for (const w of segmentation.values()) w.terminate()
      segmentation.clear()
      onnx?.terminate()
      onnx = null
    },
  }
}
