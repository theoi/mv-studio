/** Maps @fal-ai/client failures to CloudErrors with plain explanations and next steps. */
import { ApiError } from '@fal-ai/client'
import {
  browserOffline,
  cancelledError,
  CloudError,
  isAbortError,
  isFetchFailure,
  redactSecrets,
} from '../errors.ts'

const FAL_KEYS_URL = 'https://fal.ai/dashboard/keys'
const FAL_BILLING_URL = 'https://fal.ai/dashboard/billing'

function detailText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const detail =
    (body as { detail?: unknown; message?: unknown }).detail ?? (body as { message?: unknown }).message
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d !== 'object' || d === null) return String(d)
        const item = d as { msg?: unknown; loc?: unknown; type?: unknown }
        const field = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : ''
        return [field, typeof item.msg === 'string' ? item.msg : ''].filter(Boolean).join(': ')
      })
      .filter(Boolean)
      .join('; ')
  }
  return ''
}

function isContentPolicy(body: unknown, text: string): boolean {
  const types = Array.isArray((body as { detail?: unknown })?.detail)
    ? ((body as { detail: { type?: unknown }[] }).detail.map((d) => String(d?.type ?? '')) as string[])
    : []
  return (
    types.some((t) => /content_policy|nsfw|safety/i.test(t)) ||
    /content policy|nsfw|safety checker|moderation|not allowed content/i.test(text)
  )
}

export function falMissingKeyError(): CloudError {
  return new CloudError({
    kind: 'missing-key',
    provider: 'fal',
    title: 'Add your fal.ai key to generate',
    message: 'AI image and video generation runs on fal.ai with your own key. No key is set in this browser.',
    steps: [
      'Create a key at fal.ai › Dashboard › Keys.',
      'Open Settings › AI and cloud, paste the key and choose Test key.',
    ],
    helpUrl: FAL_KEYS_URL,
  })
}

export function falKeyFormatError(): CloudError {
  return new CloudError({
    kind: 'bad-key',
    provider: 'fal',
    title: "That doesn't look like a fal.ai key",
    message: 'fal.ai keys have two parts separated by a colon: the key id, then the secret.',
    steps: ['Copy the whole key from fal.ai › Dashboard › Keys, including the part after the colon.'],
    helpUrl: FAL_KEYS_URL,
  })
}

export function falKeyCheckNoAnswerError(seconds: number, cause?: unknown): CloudError {
  return new CloudError({
    kind: 'timeout',
    provider: 'fal',
    title: "fal.ai didn't answer",
    message: `No answer after ${Math.round(seconds)} s, so MV Studio stopped waiting. The key isn't saved yet.`,
    steps: [
      'Check your internet connection.',
      'Allow fal.ai, fal.run and fal.media in any ad or content blocker.',
      'Choose Try again.',
    ],
    cause,
  })
}

/** Normalizes anything thrown while talking to fal.ai. `key` is only used to scrub it from messages. */
export function mapFalError(
  error: unknown,
  options: { key?: string; signal?: AbortSignal } = {},
): CloudError {
  if (error instanceof CloudError) return error
  if (options.signal?.aborted || isAbortError(error)) return cancelledError('fal', error)
  if (isFetchFailure(error)) {
    const offline = browserOffline()
    return new CloudError({
      kind: 'network',
      provider: 'fal',
      title: offline ? "You're offline" : "Couldn't reach fal.ai",
      message: offline
        ? 'Generation needs an internet connection.'
        : 'The request to fal.ai did not get through. This is usually a connection problem or a browser extension blocking fal.ai.',
      steps: offline
        ? ['Reconnect to the internet, then choose Retry.']
        : [
            'Check your internet connection.',
            'Allow fal.ai, fal.run and fal.media in any ad or content blocker.',
            'Try again.',
          ],
      cause: error,
    })
  }
  if (error instanceof ApiError) {
    const status = error.status
    const text = redactSecrets(detailText(error.body) || error.message || '', [options.key])
    if (status === 401) {
      return new CloudError({
        kind: 'bad-key',
        provider: 'fal',
        status,
        title: 'fal.ai rejected the key',
        message:
          'fal.ai did not accept the key saved in this browser. It may be mistyped, revoked or expired.',
        steps: [
          'Copy the key again from fal.ai › Dashboard › Keys, including the part after the colon.',
          'Paste it in Settings › AI and cloud and choose Test key.',
        ],
        helpUrl: FAL_KEYS_URL,
        cause: error,
      })
    }
    if (status === 402 || (status === 403 && /balance|billing|credit|locked|exhausted|payment/i.test(text))) {
      return new CloudError({
        kind: 'insufficient-credit',
        provider: 'fal',
        status,
        title: 'Your fal.ai balance is empty',
        message: 'fal.ai accepted the key but will not run paid models until you add credit.',
        steps: ['Add credit at fal.ai › Dashboard › Billing.', 'Try again.'],
        helpUrl: FAL_BILLING_URL,
        cause: error,
      })
    }
    if (status === 403) {
      return new CloudError({
        kind: 'bad-key',
        provider: 'fal',
        status,
        title: "This key can't use that model",
        message: text || 'fal.ai refused the request for this key.',
        steps: ['Check the key’s permissions on fal.ai, or pick a different model.'],
        helpUrl: FAL_KEYS_URL,
        cause: error,
      })
    }
    if (status === 404 || status === 405) {
      return new CloudError({
        kind: 'model-not-found',
        provider: 'fal',
        status,
        title: 'That model is not available on fal.ai',
        message: 'fal.ai could not find this model. It may have been renamed or retired.',
        steps: ['Pick another model and try again.'],
        cause: error,
      })
    }
    if (status === 422 || status === 400) {
      if (isContentPolicy(error.body, text)) {
        return new CloudError({
          kind: 'content-policy',
          provider: 'fal',
          status,
          title: 'The prompt was blocked by the safety filter',
          message: 'fal.ai declined to generate this. Nothing was added to your project.',
          steps: ['Rephrase the prompt and try again.'],
          cause: error,
        })
      }
      return new CloudError({
        kind: 'invalid-request',
        provider: 'fal',
        status,
        title: 'fal.ai could not use these settings',
        message: text || 'fal.ai rejected the request settings.',
        steps: ['Try a different length, size or model.'],
        cause: error,
      })
    }
    if (status === 429) {
      return new CloudError({
        kind: 'rate-limit',
        provider: 'fal',
        status,
        title: 'fal.ai is busy for this account',
        message:
          'fal.ai limits how many requests one account runs at once (new accounts: 2). The request was not started.',
        steps: ['Wait for running generations to finish, then choose Retry.'],
        cause: error,
      })
    }
    if (status === 504 || error.isUserTimeout) {
      return new CloudError({
        kind: 'timeout',
        provider: 'fal',
        status,
        title: 'fal.ai took too long',
        message: 'The request timed out at fal.ai.',
        steps: ['Try again. If it keeps happening, pick a faster model.'],
        cause: error,
      })
    }
    if (status >= 500) {
      return new CloudError({
        kind: 'server',
        provider: 'fal',
        status,
        title: 'fal.ai had a problem',
        message: text || `fal.ai returned an error (${status}).`,
        steps: ['Try again in a moment.'],
        cause: error,
      })
    }
    return new CloudError({
      kind: 'bad-response',
      provider: 'fal',
      status,
      title: 'Unexpected answer from fal.ai',
      message: text || `fal.ai returned status ${status}.`,
      steps: ['Try again.'],
      cause: error,
    })
  }
  const message = redactSecrets(error instanceof Error ? error.message : String(error), [options.key])
  return new CloudError({
    kind: 'bad-response',
    provider: 'fal',
    title: 'Something went wrong with fal.ai',
    message: message || 'Unknown error',
    steps: ['Try again.'],
    cause: error,
  })
}
