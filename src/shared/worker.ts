/**
 * Typed request/response RPC over postMessage with progress and cancellation, for running heavy work in workers.
 *
 * In the worker:
 *   exposeWorker({ async analyze(args: { pcm: Float32Array }, ctx) { ctx.progress({ fraction: 0.5 }); return result } })
 * On the main thread:
 *   const client = createWorkerClient<typeof api>(() => new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }))
 *   const result = await client.call('analyze', { pcm }, { signal, onProgress, transfer: [pcm.buffer] })
 * As a job:
 *   jobs.run({ kind: 'analysis.beats', title: 'Finding beats', run: (ctx) => runWorkerCall(client, 'analyze', args, ctx) })
 *
 * A worker that dies (an uncaught error, a message that cannot be read, or the browser stopping it, which fires no
 * event) fails its pending calls with JobError 'out-of-memory' when its error says so, else 'worker-crashed'. A client
 * created with a function that makes the worker starts a fresh one on the next call.
 */
import {
  isOutOfMemoryMessage,
  JobError,
  type JobContext,
  type JobProgress,
  type SerializedJobError,
} from './jobs.ts'

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
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void
  start?(): void
}

type Request =
  | { kind: 'call'; id: number; method: string; args: unknown }
  | { kind: 'cancel'; id: number }
  /** Hold this Web Lock until the worker ends, so the client sees the worker stop however it stops. */
  | { kind: 'watch'; lock: string }
type Response =
  | { kind: 'progress'; id: number; progress: JobProgress }
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error'; id: number; error: SerializedJobError }
  | { kind: 'watching' }
  /** A message to the worker could not be deserialized, so some call will never be answered. */
  | { kind: 'unreadable' }

function lockManager(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks
}

export function exposeWorker(api: WorkerApi, endpoint: Endpoint = self as unknown as Endpoint): void {
  const running = new Map<number, AbortController>()
  // Calls start once the watch lock is held: a worker that died before holding it could not be noticed.
  let watched: Promise<void> = Promise.resolve()
  endpoint.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as Request
    if (msg?.kind === 'watch') {
      const locks = lockManager()
      if (!locks) return
      watched = new Promise<void>((held) => {
        locks
          .request(msg.lock, () => {
            held()
            endpoint.postMessage({ kind: 'watching' } satisfies Response)
            return new Promise<never>(() => undefined)
          })
          .catch(() => held())
      })
      return
    }
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
        await watched
        const handler = api[msg.method]
        if (!handler) throw new JobError('internal', `Unknown worker method: ${msg.method}`)
        if (controller.signal.aborted) throw new JobError('cancelled', 'Cancelled')
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
  endpoint.addEventListener('messageerror', () =>
    endpoint.postMessage({ kind: 'unreadable' } satisfies Response),
  )
  endpoint.start?.()
}

export interface CallOptions {
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
  transfer?: Transferable[]
  /**
   * On abort, keep the call pending until the worker handler has stopped (it then rejects with 'cancelled'), so the
   * caller can clean up after it, e.g. delete a file the worker was writing. By default the call rejects at once.
   */
  awaitCancel?: boolean
}

export interface WorkerClient<Api extends WorkerApi> {
  call<M extends keyof Api & string>(
    method: M,
    args: Args<Api[M]>,
    options?: CallOptions,
  ): Promise<Result<Api[M]>>
  /** Rejects pending calls with 'cancelled', terminates the worker if the endpoint is a Worker, and ends the client. */
  terminate(): void
  /**
   * The error the worker died with, or null while it runs. A client that makes its workers clears it when the next
   * call starts a fresh worker; any other client stays dead and rejects every call with it.
   */
  failure(): JobError | null
}

/** Has a lifetime of its own to watch (a Worker), unlike a MessagePort or a worker's own scope. */
function isWorker(endpoint: Endpoint | Worker): endpoint is Worker {
  return typeof (endpoint as Partial<Worker>).terminate === 'function'
}

/**
 * The error for calls pending on a worker that died. The message is for people; `details` keeps the worker's last
 * uncaught error, if it had one.
 */
function workerDied(message: string): JobError {
  const details = message.replace(/^Uncaught /, '') || undefined
  if (details && isOutOfMemoryMessage(details))
    return new JobError(
      'out-of-memory',
      'There was not enough memory to finish. Close other tabs and try again.',
      { retryable: true, details },
    )
  return new JobError('worker-crashed', 'The task stopped unexpectedly. Try again.', { details })
}

interface Pending {
  resolve(v: unknown): void
  reject(e: unknown): void
  onProgress?: (p: JobProgress) => void
  cleanup(): void
}

interface Connection {
  readonly endpoint: Endpoint
  readonly worker: Worker | null
  readonly pending: Map<number, Pending>
  /** Set when the worker died; its calls then reject with it. */
  failure: JobError | null
  /** Stops listening (on terminate() or death). */
  close(): void
}

/**
 * A client for a worker (or any endpoint) running exposeWorker(). Pass a function that makes the worker to have the
 * client start it on the first call and again after it died; pass the worker itself to use only that one.
 */
export function createWorkerClient<Api extends WorkerApi>(
  source: Endpoint | Worker | (() => Endpoint | Worker),
): WorkerClient<Api> {
  const make = typeof source === 'function' ? source : null
  let nextId = 1
  let current: Connection | null = null
  let lastFailure: JobError | null = null
  let terminated = false

  const open = (endpoint: Endpoint | Worker): Connection => {
    const ep = endpoint as Endpoint
    const worker = isWorker(endpoint) ? endpoint : null
    const stopWatching = new AbortController()
    // The browser stops a worker without any event (out of memory, for example), but it then releases the worker's
    // Web Locks: waiting for a lock the worker holds notices its end even while it is busy.
    const lock = worker && lockManager() ? `worker-alive-${crypto.randomUUID()}` : null
    let closed = false
    const conn: Connection = { endpoint: ep, worker, pending: new Map(), failure: null, close }

    function die(error: JobError) {
      if (closed) return
      close()
      conn.failure = error
      lastFailure = error
      // An uncaught error leaves the worker running in an unknown state; it is not used again.
      worker?.terminate()
      for (const p of conn.pending.values()) {
        p.cleanup()
        p.reject(error)
      }
      conn.pending.clear()
      if (make && current === conn) current = null
    }
    function onMessage(event: MessageEvent) {
      const msg = event.data as Response
      if (msg?.kind === 'watching') {
        if (lock)
          lockManager()
            ?.request(lock, { signal: stopWatching.signal }, () => die(workerDied('')))
            .catch(() => undefined)
        return
      }
      if (msg?.kind === 'unreadable') {
        die(new JobError('internal', 'The worker could not read a message'))
        return
      }
      const p = msg && conn.pending.get(msg.id)
      if (!p) return
      if (msg.kind === 'progress') {
        p.onProgress?.(msg.progress)
        return
      }
      conn.pending.delete(msg.id)
      p.cleanup()
      if (msg.kind === 'result') p.resolve(msg.value)
      else p.reject(JobError.fromJSON(msg.error))
    }
    function onError(event: Event) {
      event.preventDefault()
      die(workerDied((event as Partial<ErrorEvent>).message ?? ''))
    }
    function onMessageError() {
      die(new JobError('internal', 'A message from the worker could not be read'))
    }
    function close() {
      closed = true
      stopWatching.abort()
      ep.removeEventListener('message', onMessage)
      worker?.removeEventListener('error', onError)
      worker?.removeEventListener('messageerror', onMessageError)
    }

    ep.addEventListener('message', onMessage)
    worker?.addEventListener('error', onError)
    worker?.addEventListener('messageerror', onMessageError)
    ep.start?.()
    if (lock) ep.postMessage({ kind: 'watch', lock } satisfies Request)
    return conn
  }

  const connection = (): Connection => {
    if (current) return current
    if (!make) throw new JobError('internal', 'The worker client has no worker')
    lastFailure = null
    current = open(make())
    return current
  }

  if (!make) current = open(source as Endpoint | Worker)

  return {
    call(method, args, options = {}) {
      return new Promise((resolve, reject) => {
        const { signal } = options
        if (signal?.aborted) {
          reject(new JobError('cancelled', 'Cancelled'))
          return
        }
        if (terminated) {
          reject(new JobError('cancelled', 'Worker terminated'))
          return
        }
        let conn: Connection
        try {
          conn = connection()
        } catch (error) {
          reject(JobError.from(error))
          return
        }
        if (conn.failure) {
          reject(conn.failure)
          return
        }
        const id = nextId++
        const onAbort = () => {
          conn.endpoint.postMessage({ kind: 'cancel', id } satisfies Request)
          if (options.awaitCancel) return
          conn.pending.delete(id)
          reject(new JobError('cancelled', 'Cancelled'))
        }
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        signal?.addEventListener('abort', onAbort, { once: true })
        conn.pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          onProgress: options.onProgress,
          cleanup,
        })
        try {
          conn.endpoint.postMessage(
            { kind: 'call', id, method, args } satisfies Request,
            options.transfer ?? [],
          )
        } catch (error) {
          conn.pending.delete(id)
          cleanup()
          reject(JobError.from(error))
        }
      })
    },
    terminate() {
      terminated = true
      const conn = current
      current = null
      if (!conn) return
      conn.close()
      for (const p of conn.pending.values()) {
        p.cleanup()
        p.reject(new JobError('cancelled', 'Worker terminated'))
      }
      conn.pending.clear()
      conn.worker?.terminate()
    },
    failure: () => lastFailure,
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
