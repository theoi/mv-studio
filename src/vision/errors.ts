import { JobError, type JobErrorCode } from '../shared/jobs.ts'

export function cancelledError(cause?: unknown): JobError {
  return new JobError('cancelled', 'Cancelled', { cause })
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError(signal.reason)
}

/**
 * Normalizes anything a model runtime throws into a JobError. Unlike JobError.from, it recognizes the ways
 * WASM runtimes report heap exhaustion, and lets the caller pick the code for unknown failures.
 */
export function visionError(err: unknown, fallback: JobErrorCode = 'internal'): JobError {
  if (err instanceof JobError) return err
  const normalized = JobError.from(err)
  if (normalized.code !== 'internal') return normalized
  // ONNX Runtime reports WASM heap exhaustion as std::bad_alloc; Emscripten as "Out of memory".
  if (/bad_alloc|out of memory|Array buffer allocation failed/i.test(normalized.message))
    return new JobError('out-of-memory', normalized.message, { cause: err })
  return new JobError(fallback, normalized.message, { cause: err })
}
