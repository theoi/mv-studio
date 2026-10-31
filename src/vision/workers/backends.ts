import type { OnnxBackend, SegmentationBackend, SegmentationRole, VisionBackends } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import {
  createWorkerClient,
  type CallOptions,
  type Transferred,
  type WorkerApi,
  type WorkerClient,
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
 * Worker handle that is (re)created on demand: after a crash the next call starts a fresh worker instead of
 * failing forever, and calls pending at the crash reject instead of hanging. State in the crashed worker
 * (loaded models, unfinished tracks) is lost, so running jobs fail.
 */
function lazyWorker<Api extends WorkerApi>(
  create: () => Worker,
): { client: Methods<Api>; terminate(): void } {
  let current: { worker: Worker; client: WorkerClient<Api>; crashed: Promise<never> } | null = null

  const get = () => {
    if (current) return current
    const worker = create()
    const client = createWorkerClient<Api>(worker)
    const crashed = new Promise<never>((_, reject) => {
      worker.addEventListener('error', (event) => {
        if (current?.worker === worker) current = null
        client.terminate()
        reject(new JobError('internal', event.message || 'The vision worker stopped unexpectedly.'))
      })
    })
    crashed.catch(() => undefined)
    current = { worker, client, crashed }
    return current
  }

  const client = new Proxy({} as Methods<Api>, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined
      return (args: unknown, options?: CallOptions) => {
        const w = get()
        const call = w.client.call(method as keyof Api & string, args as never, options)
        return Promise.race([call, w.crashed])
      }
    },
  })
  return {
    client,
    terminate() {
      current?.client.terminate()
      current = null
    },
  }
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
