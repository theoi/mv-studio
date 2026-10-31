/**
 * Typed request/response RPC over postMessage with progress and cancellation, for running heavy work in workers.
 *
 * In the worker:
 *   exposeWorker({ async analyze(args: { pcm: Float32Array }, ctx) { ctx.progress({ fraction: 0.5 }); return result } })
 * On the main thread:
 *   const client = createWorkerClient<typeof api>(new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }))
 *   const result = await client.call('analyze', { pcm }, { signal, onProgress, transfer: [pcm.buffer] })
 * As a job:
 *   jobs.run({ kind: 'analysis.beats', title: 'Finding beats', run: (ctx) => runWorkerCall(client, 'analyze', args, ctx) })
 */
import { JobError, type JobContext, type JobProgress, type SerializedJobError } from './jobs.ts'

export interface WorkerCallContext {
  readonly signal: AbortSignal
  progress(update: JobProgress): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkerHandler = (args: any, ctx: WorkerCallContext) => unknown
export type WorkerApi = Record<string, WorkerHandler>

type Args<F> = F extends (args: infer A, ctx: WorkerCallContext) => unknown ? A : never
type Result<F> = F extends (...a: never[]) => infer R
  ? Awaited<R> extends Transferred<infer V>
    ? V
    : Awaited<R>
  : never

const TRANSFER = Symbol('transfer')
export interface Transferred<T> {
  readonly [TRANSFER]: true
  readonly value: T
  readonly transfer: Transferable[]
}

/** Wrap a worker handler's return value to transfer (not copy) buffers back to the caller. */
export function transfer<T>(value: T, transferables: Transferable[]): Transferred<T> {
  return { [TRANSFER]: true, value, transfer: transferables }
}

function isTransferred(v: unknown): v is Transferred<unknown> {
  return typeof v === 'object' && v !== null && TRANSFER in v
}

/** Anything with postMessage + message events: Worker, DedicatedWorkerGlobalScope, MessagePort. */
export interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  start?(): void
}

type Request = { kind: 'call'; id: number; method: string; args: unknown } | { kind: 'cancel'; id: number }
type Response =
  | { kind: 'progress'; id: number; progress: JobProgress }
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error'; id: number; error: SerializedJobError }

export function exposeWorker(api: WorkerApi, endpoint: Endpoint = self as unknown as Endpoint): void {
  const running = new Map<number, AbortController>()
  endpoint.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as Request
    if (msg?.kind === 'cancel') {
      running.get(msg.id)?.abort()
      return
    }
    if (msg?.kind !== 'call') return
    const controller = new AbortController()
    running.set(msg.id, controller)
    const ctx: WorkerCallContext = {
      signal: controller.signal,
      progress: (progress) =>
        endpoint.postMessage({ kind: 'progress', id: msg.id, progress } satisfies Response),
    }
    void (async () => {
      try {
        const handler = api[msg.method]
        if (!handler) throw new JobError('internal', `Unknown worker method: ${msg.method}`)
        const out = await handler(msg.args, ctx)
        if (controller.signal.aborted) throw new JobError('cancelled', 'Cancelled')
        if (isTransferred(out))
          endpoint.postMessage(
            { kind: 'result', id: msg.id, value: out.value } satisfies Response,
            out.transfer,
          )
        else endpoint.postMessage({ kind: 'result', id: msg.id, value: out } satisfies Response)
      } catch (error) {
        const err = controller.signal.aborted ? new JobError('cancelled', 'Cancelled') : JobError.from(error)
        endpoint.postMessage({ kind: 'error', id: msg.id, error: err.toJSON() } satisfies Response)
      } finally {
        running.delete(msg.id)
      }
    })()
  })
  endpoint.start?.()
}

export interface CallOptions {
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
  transfer?: Transferable[]
}

export interface WorkerClient<Api extends WorkerApi> {
  call<M extends keyof Api & string>(
    method: M,
    args: Args<Api[M]>,
    options?: CallOptions,
  ): Promise<Result<Api[M]>>
  /** Rejects pending calls with 'cancelled' and terminates the worker if the endpoint is a Worker. */
  terminate(): void
}

export function createWorkerClient<Api extends WorkerApi>(endpoint: Endpoint | Worker): WorkerClient<Api> {
  const ep = endpoint as Endpoint
  let nextId = 1
  const pending = new Map<
    number,
    {
      resolve(v: unknown): void
      reject(e: unknown): void
      onProgress?: (p: JobProgress) => void
      cleanup(): void
    }
  >()
  const onMessage = (event: MessageEvent) => {
    const msg = event.data as Response
    const p = pending.get(msg?.id)
    if (!p) return
    if (msg.kind === 'progress') {
      p.onProgress?.(msg.progress)
      return
    }
    pending.delete(msg.id)
    p.cleanup()
    if (msg.kind === 'result') p.resolve(msg.value)
    else p.reject(JobError.fromJSON(msg.error))
  }
  ep.addEventListener('message', onMessage)
  ep.start?.()

  return {
    call(method, args, options = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const { signal } = options
        if (signal?.aborted) {
          reject(new JobError('cancelled', 'Cancelled'))
          return
        }
        const onAbort = () => {
          ep.postMessage({ kind: 'cancel', id } satisfies Request)
          pending.delete(id)
          reject(new JobError('cancelled', 'Cancelled'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          onProgress: options.onProgress,
          cleanup: () => signal?.removeEventListener('abort', onAbort),
        })
        ep.postMessage({ kind: 'call', id, method, args } satisfies Request, options.transfer ?? [])
      })
    },
    terminate() {
      ep.removeEventListener('message', onMessage)
      for (const [, p] of pending) {
        p.cleanup()
        p.reject(new JobError('cancelled', 'Worker terminated'))
      }
      pending.clear()
      if (typeof Worker !== 'undefined' && endpoint instanceof Worker) endpoint.terminate()
    },
  }
}

/** Runs one worker call inside a job, wiring the job's cancel signal and progress through. */
export function runWorkerCall<Api extends WorkerApi, M extends keyof Api & string>(
  client: WorkerClient<Api>,
  method: M,
  args: Args<Api[M]>,
  ctx: JobContext,
  transferList?: Transferable[],
): Promise<Result<Api[M]>> {
  return client.call(method, args, {
    signal: ctx.signal,
    onProgress: (p) => ctx.progress(p),
    transfer: transferList,
  })
}
