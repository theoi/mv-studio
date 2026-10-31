/**
 * A fetch that behaves like a browser page on PAGE_ORIGIN: requests go to in-process mock servers by origin, and a
 * cross-origin response without a matching Access-Control-Allow-Origin header fails with the same TypeError a
 * browser throws. Unknown hosts (a server that is not running) fail the same way.
 */
export const PAGE_ORIGIN = 'https://theoi.github.io'

export type MockHandler = (request: Request) => Response | Promise<Response>

export interface BrowserFetch {
  fetch: typeof fetch
  requests: { method: string; url: string; headers: Record<string, string>; body?: unknown }[]
}

export function browserFetch(servers: Record<string, MockHandler>, pageOrigin = PAGE_ORIGIN): BrowserFetch {
  const requests: BrowserFetch['requests'] = []
  const doFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => (headers[key] = value))
    let body: unknown
    const type = request.headers.get('content-type') ?? ''
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (type.includes('application/json')) {
        const text = await request.clone().text()
        body = text ? (JSON.parse(text) as unknown) : undefined
      } else {
        body = await request.clone().blob()
      }
    }
    requests.push({ method: request.method, url: request.url, headers, body })
    const handler = servers[url.origin]
    if (!handler) throw new TypeError('Failed to fetch')
    const withOrigin = new Headers(request.headers)
    if (url.origin !== pageOrigin) withOrigin.set('origin', pageOrigin)
    // Like a real fetch, an aborted signal rejects the request even if the server never answers.
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      if (request.signal.aborted) fail()
      else request.signal.addEventListener('abort', fail, { once: true })
    })
    const response = await Promise.race([handler(new Request(request, { headers: withOrigin })), aborted])
    const allowed = response.headers.get('access-control-allow-origin')
    if (url.origin !== pageOrigin && allowed !== '*' && allowed !== pageOrigin)
      throw new TypeError('Failed to fetch')
    return response
  }
  return { fetch: doFetch as typeof fetch, requests }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
