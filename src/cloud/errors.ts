/**
 * Typed cloud errors. Every provider failure becomes a CloudError: a JobError (so jobs, toasts and retry buttons work
 * unchanged) whose `details.cloud` carries a plain-language title, explanation and concrete steps for the UI.
 * Messages are passed through redactSecrets() so keys never reach the UI, logs or saved job state.
 */
import { JobError, type JobErrorCode, type SerializedJobError } from '../shared/jobs.ts'

export type CloudProviderId = 'fal' | 'llm'

export type CloudErrorKind =
  /** No key configured for a provider that needs one. */
  | 'missing-key'
  /** The provider rejected the key (401/403). */
  | 'bad-key'
  /** Out of credit or quota (402, fal "exhausted balance", OpenAI insufficient_quota). */
  | 'insufficient-credit'
  /** Too many requests or too many running at once (429). */
  | 'rate-limit'
  /** A cloud endpoint could not be reached: offline, DNS, or blocked by CORS. */
  | 'network'
  /** A local LLM (Ollama, LM Studio) could not be reached: not running, CORS not enabled, or the browser blocked it. */
  | 'local-server'
  /** A plain-http endpoint on another machine; the browser blocks it from an https page. */
  | 'insecure-endpoint'
  | 'model-not-found'
  | 'invalid-request'
  | 'content-policy'
  | 'server'
  | 'timeout'
  | 'cancelled'
  /** The provider answered, but not in a usable shape. */
  | 'bad-response'
  /** The endpoint lacks a needed feature (for example tool calling and JSON output). */
  | 'unsupported'
  /** A local runner cut the prompt to fit its context length and answered anyway (Ollama does this silently). */
  | 'prompt-cut'

export interface CloudErrorInfo {
  kind: CloudErrorKind
  provider: CloudProviderId
  /** Short headline, e.g. "fal.ai rejected the key". */
  title: string
  /** HTTP status when the provider answered. */
  status?: number
  /** What the user can do, in order. */
  steps: string[]
  helpUrl?: string
}

const JOB_CODE: Record<CloudErrorKind, JobErrorCode> = {
  'missing-key': 'provider',
  'bad-key': 'provider',
  'insufficient-credit': 'provider',
  'rate-limit': 'provider',
  network: 'network',
  'local-server': 'network',
  'insecure-endpoint': 'network',
  'model-not-found': 'provider',
  'invalid-request': 'invalid-input',
  'content-policy': 'provider',
  server: 'provider',
  timeout: 'timeout',
  cancelled: 'cancelled',
  'bad-response': 'provider',
  unsupported: 'unsupported',
  'prompt-cut': 'invalid-input',
}

const RETRYABLE = new Set<CloudErrorKind>(['rate-limit', 'network', 'local-server', 'server', 'timeout'])

export class CloudError extends JobError {
  readonly kind: CloudErrorKind
  readonly provider: CloudProviderId
  readonly status?: number
  readonly title: string
  readonly steps: string[]
  readonly helpUrl?: string
  /** The request had finished but the provider doesn't charge for this failure (fal.ai's own server errors). */
  readonly uncharged: boolean

  constructor(
    info: Omit<CloudErrorInfo, 'steps'> & {
      steps?: string[]
      message: string
      cause?: unknown
      uncharged?: boolean
    },
  ) {
    const steps = info.steps ?? []
    const cloud: CloudErrorInfo = {
      kind: info.kind,
      provider: info.provider,
      title: info.title,
      status: info.status,
      steps,
      helpUrl: info.helpUrl,
    }
    super(JOB_CODE[info.kind], info.message, {
      retryable: RETRYABLE.has(info.kind),
      details: { cloud },
      cause: info.cause,
    })
    this.name = 'CloudError'
    this.kind = info.kind
    this.provider = info.provider
    this.status = info.status
    this.title = info.title
    this.steps = steps
    this.helpUrl = info.helpUrl
    this.uncharged = info.uncharged ?? false
  }

  get info(): CloudErrorInfo {
    return (this.details as { cloud: CloudErrorInfo }).cloud
  }
}

/** Reads the cloud details from a CloudError, or from a JobError/job snapshot error that came from one. */
export function cloudErrorInfo(error: unknown): CloudErrorInfo | undefined {
  if (error instanceof CloudError) return error.info
  const details =
    error instanceof JobError
      ? error.details
      : typeof error === 'object' && error !== null
        ? (error as SerializedJobError).details
        : undefined
  const cloud = (details as { cloud?: CloudErrorInfo } | undefined)?.cloud
  return cloud && typeof cloud.kind === 'string' ? cloud : undefined
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_*-]{6,}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{16,}\b/gi,
  /\b(Bearer|Key)\s+[A-Za-z0-9._:*-]{8,}/g,
]

/** Removes known secrets and key-shaped strings from text that may be shown or stored. */
export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[key hidden]')
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[key hidden]')
  return out
}

/** True for the TypeError browsers throw when a request is blocked (CORS, offline, server down, mixed content). */
export function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  return /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(error.message)
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error instanceof JobError && error.code === 'cancelled'))
  )
}

export function cancelledError(provider: CloudProviderId, cause?: unknown): CloudError {
  return new CloudError({ kind: 'cancelled', provider, title: 'Cancelled', message: 'Cancelled', cause })
}

/** True when the page is offline according to the browser. */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}
