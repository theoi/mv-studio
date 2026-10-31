/**
 * In-process mock of the fal.ai queue, storage and media hosts, following the documented API: submit returns
 * request/status/response/cancel URLs built from owner/alias only; status moves IN_QUEUE → IN_PROGRESS → COMPLETED;
 * results and errors use fal's JSON shapes ({"detail": ...}); CORS headers reflect the page origin.
 */
import { json, PAGE_ORIGIN, type MockHandler } from './browser.ts'

export interface FalScript {
  /** Statuses returned by successive status polls; the last one repeats. */
  statuses?: ('IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED')[]
  result?: unknown
  submitError?: { status: number; body: unknown }
  resultError?: { status: number; body: unknown }
}

interface QueuedRequest {
  id: string
  app: string
  endpoint: string
  input: unknown
  polls: number
  cancelled: boolean
  script: FalScript
}

export const FAL_TEST_KEY = '11111111-2222-3333-4444-555555555555:0123456789abcdef0123456789abcdef'

const cors = { 'access-control-allow-origin': PAGE_ORIGIN, vary: 'origin' }
const corsAll = { 'access-control-allow-origin': '*' }

export class MockFalServer {
  validKey = FAL_TEST_KEY
  readonly queued = new Map<string, QueuedRequest>()
  readonly uploads = new Map<string, Blob>()
  /** Content-Type of each upload, by the same token as `uploads`. */
  readonly uploadTypes = new Map<string, string>()
  /** Bodies of upload initiations, in order. */
  readonly initiated: { file_name: string; content_type: string }[] = []
  readonly files = new Map<string, Blob>()
  private scripts = new Map<string, FalScript>()
  private nextId = 1

  /** Sets the behavior for an endpoint id such as 'fal-ai/flux/schnell'. */
  script(endpoint: string, script: FalScript): void {
    this.scripts.set(endpoint, script)
  }

  /** Registers a downloadable result file and returns its public URL. */
  file(name: string, blob: Blob): string {
    const url = `https://v3.fal.media/files/mock/${name}`
    this.files.set(url, blob)
    return url
  }

  servers(): Record<string, MockHandler> {
    return {
      'https://queue.fal.run': (r) => this.queue(r),
      'https://rest.fal.ai': (r) => this.rest(r),
      'https://v3.fal.media': (r) => this.media(r),
    }
  }

  private authorized(request: Request): boolean {
    return request.headers.get('authorization') === `Key ${this.validKey}`
  }

  private async queue(request: Request): Promise<Response> {
    if (!this.authorized(request)) return json({ detail: 'invalid key credentials' }, 401, cors)
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const reqIndex = parts.indexOf('requests')
    if (request.method === 'POST' && reqIndex < 0) {
      const endpoint = parts.join('/')
      const script = this.scripts.get(endpoint) ?? {}
      if (script.submitError) return json(script.submitError.body, script.submitError.status, cors)
      const id = `req-${this.nextId++}`
      const app = parts.slice(0, 2).join('/')
      this.queued.set(id, {
        id,
        app,
        endpoint,
        input: await request.json(),
        polls: 0,
        cancelled: false,
        script,
      })
      return json({ ...this.urls(app, id), status: 'IN_QUEUE', queue_position: 2 }, 200, cors)
    }
    // Status, result and cancel live under owner/alias only; longer paths are rejected like the real service.
    if (reqIndex !== 2) return json({ detail: 'Method Not Allowed' }, 405, cors)
    const app = parts.slice(0, 2).join('/')
    const id = parts[3] ?? ''
    const queued = this.queued.get(id)
    if (!queued || queued.app !== app) return json({ detail: 'Request not found' }, 404, cors)
    const action = parts[4]
    if (action === 'status' && request.method === 'GET') {
      const statuses = queued.script.statuses ?? ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']
      const status = statuses[Math.min(queued.polls, statuses.length - 1)] ?? 'COMPLETED'
      queued.polls += 1
      const logs =
        url.searchParams.get('logs') === '1'
          ? [{ message: 'step', level: 'INFO', source: 'USER', timestamp: '' }]
          : []
      return json(
        {
          ...this.urls(app, id),
          status,
          ...(status === 'IN_QUEUE' ? { queue_position: Math.max(0, 1 - queued.polls) } : { logs }),
        },
        200,
        cors,
      )
    }
    if (action === 'cancel' && request.method === 'PUT') {
      queued.cancelled = true
      return json({ status: 'CANCELLATION_REQUESTED' }, 202, cors)
    }
    if (action === undefined && request.method === 'GET') {
      if (queued.script.resultError)
        return json(queued.script.resultError.body, queued.script.resultError.status, cors)
      return json(queued.script.result ?? {}, 200, { ...cors, 'x-fal-request-id': id })
    }
    return json({ detail: 'Not Found' }, 404, cors)
  }

  private async rest(request: Request): Promise<Response> {
    if (!this.authorized(request)) {
      return json(
        { detail: "Invalid Key Authorization header format. Expected '<key_id>:<key_secret>'." },
        401,
        cors,
      )
    }
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/storage/upload/initiate') {
      const body = (await request.json()) as { file_name: string; content_type: string }
      this.initiated.push({ file_name: body.file_name, content_type: body.content_type })
      const token = `up${this.nextId++}`
      return json(
        {
          upload_url: `https://v3.fal.media/upload/${token}?sig=x`,
          file_url: `https://v3.fal.media/files/${token}/${body.file_name}`,
        },
        200,
        cors,
      )
    }
    return json({ detail: 'Not Found' }, 404, cors)
  }

  private async media(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const token = url.pathname.split('/')[2] ?? ''
      this.uploads.set(token, await request.blob())
      this.uploadTypes.set(token, request.headers.get('content-type') ?? '')
      return new Response('', { status: 200, headers: corsAll })
    }
    const file = this.files.get(`${url.origin}${url.pathname}`)
    if (request.method === 'GET' && file) {
      return new Response(file, { status: 200, headers: { ...corsAll, 'content-type': file.type } })
    }
    return new Response('not found', { status: 404, headers: corsAll })
  }

  private urls(app: string, id: string) {
    const base = `https://queue.fal.run/${app}/requests/${id}`
    return { request_id: id, response_url: base, status_url: `${base}/status`, cancel_url: `${base}/cancel` }
  }
}
