/**
 * Job runtime: every long task (analysis, stems, lyrics, segmentation, export, cloud generation) runs as a job
 * with progress, cancellation and typed errors, so the UI can show one consistent progress/cancel/error surface.
 * Heavy work belongs in a worker; see ./worker.ts and runWorkerJob().
 */

export type JobErrorCode =
  | 'cancelled'
  | 'unsupported'
  | 'invalid-input'
  | 'network'
  | 'model-load'
  | 'decode'
  | 'encode'
  | 'storage-quota'
  | 'out-of-memory'
  /** The worker running the task died; a fresh one is used on retry. */
  | 'worker-crashed'
  | 'provider'
  | 'timeout'
  | 'internal'

export interface SerializedJobError {
  code: JobErrorCode
  message: string
  retryable: boolean
  details?: unknown
}

export class JobError extends Error {
  readonly code: JobErrorCode
  readonly retryable: boolean
  readonly details?: unknown

  constructor(
    code: JobErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'JobError'
    this.code = code
    this.retryable =
      options.retryable ?? (code === 'network' || code === 'timeout' || code === 'worker-crashed')
    this.details = options.details
  }

  toJSON(): SerializedJobError {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
  }

  static fromJSON(e: SerializedJobError): JobError {
    return new JobError(e.code, e.message, { retryable: e.retryable, details: e.details })
  }

  /**
   * Normalizes anything thrown into a JobError (AbortError becomes 'cancelled', QuotaExceededError 'storage-quota',
   * exhausted memory 'out-of-memory').
   */
  static from(error: unknown): JobError {
    if (error instanceof JobError) return error
    if (isDomException(error, 'AbortError')) return new JobError('cancelled', 'Cancelled', { cause: error })
    if (isDomException(error, 'QuotaExceededError'))
      return new JobError('storage-quota', 'Not enough browser storage space', { cause: error })
    const message = error instanceof Error ? error.message : String(error)
    if ((error instanceof RangeError && /memory|allocation/i.test(message)) || isOutOfMemoryMessage(message))
      return new JobError('out-of-memory', message, { cause: error })
    return new JobError('internal', message || 'Unknown error', { cause: error })
  }
}

/**
 * Whether an error message says memory ran out, in the words of V8 ("Array buffer allocation failed"), WebAssembly
 * ("Maximum memory size exceeded"), Emscripten ("Out of memory", "OOM") and ONNX Runtime ("bad_alloc").
 */
export function isOutOfMemoryMessage(message: string): boolean {
  return /out of memory|\bOOM\b|bad_alloc|allocation failed|could not allocate|memory size exceeded|grow (instance )?memory/i.test(
    message,
  )
}

function isDomException(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name
}

export interface JobProgress {
  /** 0..1 when known; omit for indeterminate progress. */
  fraction?: number
  /** Short machine-friendly stage id, e.g. 'download', 'decode', 'separate'. */
  stage?: string
  /** Human-readable status line for the UI. */
  message?: string
  bytesLoaded?: number
  bytesTotal?: number
  etaSeconds?: number
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobContext {
  readonly signal: AbortSignal
  progress(update: JobProgress): void
  /** Throws JobError('cancelled') if the job was cancelled. Call between work chunks. */
  throwIfCancelled(): void
}

export interface JobSpec<T> {
  /** Category for grouping and analytics-free UI labels, e.g. 'analysis.beats', 'export.mp4'. */
  kind: string
  /** User-facing title, e.g. 'Separating stems'. */
  title: string
  run(ctx: JobContext): Promise<T>
}

export interface JobSnapshot {
  id: string
  kind: string
  title: string
  status: JobStatus
  progress: JobProgress
  error?: SerializedJobError
  startedAt?: number
  finishedAt?: number
  /** Cancel was requested and the job has not ended yet: it may still be finishing work it must not drop. */
  stopping?: boolean
}

export interface JobHandle<T> {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly promise: Promise<T>
  snapshot(): JobSnapshot
  cancel(): void
  subscribe(listener: (snapshot: JobSnapshot) => void): () => void
}

type Listener<T> = (value: T) => void

class Job<T> implements JobHandle<T> {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly promise: Promise<T>
  private readonly controller = new AbortController()
  private state: JobSnapshot
  private readonly listeners = new Set<Listener<JobSnapshot>>()
  private readonly now: () => number

  constructor(spec: JobSpec<T>, onChange: () => void, now: () => number) {
    this.now = now
    this.id = crypto.randomUUID()
    this.kind = spec.kind
    this.title = spec.title
    this.state = { id: this.id, kind: spec.kind, title: spec.title, status: 'queued', progress: {} }
    this.listeners.add(onChange)
    this.promise = this.start(spec)
    // Callers that only use subscribe() must not trigger unhandled-rejection noise.
    this.promise.catch(() => undefined)
  }

  private async start(spec: JobSpec<T>): Promise<T> {
    await Promise.resolve()
    const signal = this.controller.signal
    const ctx: JobContext = {
      signal,
      progress: (update) => {
        if (this.state.status !== 'running') return
        this.update({ progress: { ...this.state.progress, ...update } })
      },
      throwIfCancelled: () => {
        if (signal.aborted) throw new JobError('cancelled', 'Cancelled')
      },
    }
    try {
      ctx.throwIfCancelled()
      this.update({ status: 'running', startedAt: this.now() })
      const result = await spec.run(ctx)
      ctx.throwIfCancelled()
      this.update({
        status: 'succeeded',
        finishedAt: this.now(),
        progress: { ...this.state.progress, fraction: 1 },
      })
      return result
    } catch (error) {
      const err = signal.aborted
        ? new JobError('cancelled', 'Cancelled', { cause: error })
        : JobError.from(error)
      this.update({
        status: err.code === 'cancelled' ? 'cancelled' : 'failed',
        error: err.toJSON(),
        finishedAt: this.now(),
        stopping: undefined,
      })
      throw err
    }
  }

  private update(patch: Partial<JobSnapshot>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }

  snapshot(): JobSnapshot {
    return this.state
  }

  cancel(): void {
    if (this.state.status !== 'queued' && this.state.status !== 'running') return
    if (!this.state.stopping) this.update({ stopping: true })
    this.controller.abort()
  }

  subscribe(listener: Listener<JobSnapshot>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** Tracks running and recent jobs for the app (progress tray, cancel buttons, error toasts). */
export class JobRunner {
  private readonly jobs = new Map<string, Job<unknown>>()
  private readonly listeners = new Set<Listener<JobSnapshot[]>>()
  private snapshots: JobSnapshot[] = []

  private readonly options: { keepFinished?: number; now?: () => number }

  constructor(options: { keepFinished?: number; now?: () => number } = {}) {
    this.options = options
  }

  run<T>(spec: JobSpec<T>): JobHandle<T> {
    const job = new Job(spec, () => this.emit(), this.options.now ?? (() => Date.now()))
    this.jobs.set(job.id, job as Job<unknown>)
    this.prune()
    this.emit()
    return job
  }

  get(id: string): JobHandle<unknown> | undefined {
    return this.jobs.get(id)
  }

  cancel(id: string): void {
    this.jobs.get(id)?.cancel()
  }

  cancelAll(kind?: string): void {
    for (const job of this.jobs.values()) if (!kind || job.kind === kind) job.cancel()
  }

  /** Stable snapshot array, suitable for React's useSyncExternalStore. */
  list(): JobSnapshot[] {
    return this.snapshots
  }

  subscribe(listener: Listener<JobSnapshot[]>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private prune() {
    const keep = this.options.keepFinished ?? 20
    const finished = [...this.jobs.values()].filter((j) => {
      const s = j.snapshot().status
      return s === 'succeeded' || s === 'failed' || s === 'cancelled'
    })
    for (const job of finished.slice(0, Math.max(0, finished.length - keep))) this.jobs.delete(job.id)
  }

  private emit() {
    this.snapshots = [...this.jobs.values()].map((j) => j.snapshot())
    for (const l of this.listeners) l(this.snapshots)
  }
}

/** App-wide runner. Feature modules may also create their own for isolated tests. */
export const jobs = new JobRunner()
