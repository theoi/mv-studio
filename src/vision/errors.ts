import { JobError, type JobErrorCode } from '../shared/jobs.ts'
import { failedMessage, theModel } from '../shared/models.ts'
import { VISION_MODEL_TITLES, type VisionModel } from './runtime/models.ts'

export function cancelledError(cause?: unknown): JobError {
  return new JobError('cancelled', 'Cancelled', { cause })
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError(signal.reason)
}

/**
 * Whether a model failed to download or load (offline, a blocked host, a bad file), rather than failing on its input.
 */
export function isModelUnavailable(err: unknown): boolean {
  return err instanceof JobError && (err.code === 'network' || err.code === 'model-load')
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

/** Errors already naming their model, so a caller further up does not name it again. */
const named = new WeakSet<JobError>()

function naming(e: JobError, message: string, err: unknown): JobError {
  const out = new JobError(e.code, message, { cause: err, retryable: e.retryable, details: e.message })
  named.add(out)
  return out
}

/**
 * The error for a model that could not be downloaded, naming it as the app does. The shared loader names the model
 * itself, with what to do, when it has the model's title (`loadingModel` and the MediaPipe loader pass it), and that
 * error passes unchanged. Anything else, such as MediaPipe's runtime failing to load, gets the same sentence, with
 * its message (the file's URL, say) in `details`. Errors with other codes (cancelled, out of memory, storage) pass
 * unchanged.
 */
export function downloadFailed(model: VisionModel, err: unknown): JobError {
  const e = visionError(err, 'model-load')
  if (named.has(e) || (e.code !== 'network' && e.code !== 'model-load')) return e
  const title = VISION_MODEL_TITLES[model]
  if (e.message.includes(theModel(title))) {
    named.add(e)
    return e
  }
  return naming(e, failedMessage(title, 'Check your connection and try again.', e.message), err)
}

/** The error for a downloaded model that could not be started, named as in `downloadFailed`. */
export function startFailed(model: VisionModel, err: unknown): JobError {
  const e = visionError(err, 'model-load')
  if (named.has(e) || e.code !== 'model-load') return e
  return naming(e, `Couldn’t start ${theModel(VISION_MODEL_TITLES[model])}`, err)
}
