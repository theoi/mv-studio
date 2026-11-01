/**
 * MediaPipe Tasks posts usage metrics to Google (odml.pa.googleapis.com) from every task it creates, every 60 s and
 * when the task closes, through the context's `fetch`. It has no setting to turn this off, and its maintainers' advice
 * is to block the host. The studio promises that it processes media on the computer, so the contexts that create
 * MediaPipe tasks answer these requests themselves, without the network.
 */

/** Google's private API hosts, where MediaPipe sends its logs. The studio uses none of them. */
const BLOCKED_HOST = /(^|[.-])pa\.googleapis\.com$/

/** Performance mark recorded for each blocked request (detail: its URL without the query), for DevTools and tests. */
export const BLOCKED_REQUEST_MARK = 'mv-studio:blocked-request'

function requestUrl(input: RequestInfo | URL): URL | null {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(href, globalThis.location?.href)
  } catch {
    return null
  }
}

const guarded = new WeakSet<typeof fetch>()

/**
 * A `fetch` that answers requests to the blocked hosts with 403 and passes every other request to `inner`.
 * MediaPipe's logger takes any status but 200 as a failed send: it drops its queue and stops, retrying and logging
 * nothing.
 */
export function withoutTelemetry(inner: typeof fetch): typeof fetch {
  const guard: typeof fetch = (input, init) => {
    const url = requestUrl(input)
    if (!url || !BLOCKED_HOST.test(url.hostname)) return inner(input, init)
    performance.mark(BLOCKED_REQUEST_MARK, { detail: `${url.origin}${url.pathname}` })
    return Promise.resolve(new Response(null, { status: 403, statusText: 'Blocked' }))
  }
  guarded.add(guard)
  return guard
}

/** Makes the context's `fetch` block MediaPipe's usage logs; does nothing if it already does. */
export function blockTelemetry(scope: { fetch: typeof fetch } = globalThis): void {
  if (guarded.has(scope.fetch)) return
  scope.fetch = withoutTelemetry(scope.fetch.bind(scope))
}
