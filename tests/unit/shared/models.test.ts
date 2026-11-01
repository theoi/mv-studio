import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wasmThreadCount } from '../../../src/shared/capabilities.ts'
import { JobError, type JobProgress } from '../../../src/shared/jobs.ts'
import { configureOnnxEnv, downloadingModel, fetchModelFile } from '../../../src/shared/models.ts'

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers })
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchModelFile', () => {
  it('streams with progress and sends a credential-less CORS request', async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([new Uint8Array(30), new Uint8Array(70)], { 'content-length': '100' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const fractions: (number | undefined)[] = []
    const buf = await fetchModelFile(
      { url: 'https://huggingface.co/x/resolve/main/model.onnx' },
      { onProgress: (p) => fractions.push(p.fraction) },
    )
    expect(buf.byteLength).toBe(100)
    expect(fractions).toEqual([0, 0.3, 1])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://huggingface.co/x/resolve/main/model.onnx',
      expect.objectContaining({ mode: 'cors', credentials: 'omit' }),
    )
  })

  it('rejects a checksum mismatch as a model-load error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse([new Uint8Array([1, 2, 3])])),
    )
    const error = (await fetchModelFile({ url: 'https://example.com/m.onnx', sha256: '00'.repeat(32) }).catch(
      (e: unknown) => e,
    )) as JobError
    expect(error).toBeInstanceOf(JobError)
    expect(error.code).toBe('model-load')
  })

  it('marks server errors retryable and client errors not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    )
    const busy = (await fetchModelFile({ url: 'https://example.com/a' }).catch((e: unknown) => e)) as JobError
    expect(busy.retryable).toBe(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    const missing = (await fetchModelFile({ url: 'https://example.com/b' }).catch(
      (e: unknown) => e,
    )) as JobError
    expect(missing.retryable).toBe(false)
  })
})

/** A fetch that never answers, and fails as the browser's does when its request is aborted. */
function silentFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  )
}

/**
 * A fetch whose response bytes arrive when the test sends them; its body fails as the browser's does when aborted.
 * With `answerLater`, the response itself comes only when the test calls `answer()`.
 */
function tricklingFetch(options: { answerLater?: boolean } = {}) {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  let answer = (): void => undefined
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        answer = () => {
          const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c) })
          init?.signal?.addEventListener('abort', () =>
            body?.error(new DOMException('Aborted', 'AbortError')),
          )
          resolve(new Response(stream, { status: 200 }))
        }
        if (!options.answerLater) answer()
      }),
  )
  return {
    fetchMock,
    answer: () => answer(),
    send: (bytes: number) => body?.enqueue(new Uint8Array(bytes)),
    end: () => body?.close(),
  }
}

/** `fetchModelFile`'s outcome so far: 'waiting', 'loaded' or the error it threw. */
function watch(load: Promise<ArrayBuffer>) {
  const seen: { outcome: unknown } = { outcome: 'waiting' }
  const settled = load.then(
    () => (seen.outcome = 'loaded'),
    (e: unknown) => (seen.outcome = e),
  )
  return { seen, settled }
}

describe('a model download that gets no bytes', () => {
  const url = 'https://huggingface.co/x/resolve/abc/model.onnx'
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports its download stage as the request starts, before the server answers', async () => {
    vi.stubGlobal('fetch', silentFetch())
    const reports: JobProgress[] = []
    const cancel = new AbortController()
    const { settled } = watch(
      fetchModelFile(
        { url, bytes: 95_000_000 },
        { signal: cancel.signal, onProgress: (p) => reports.push(p) },
      ),
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reports).toEqual([{ stage: 'download', fraction: 0, bytesLoaded: 0, bytesTotal: 95_000_000 }])
    cancel.abort()
    await settled
  })

  it('gives up after 30 s without a response, as a retryable network error naming the model', async () => {
    const fetchMock = silentFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { seen, settled } = watch(fetchModelFile({ url }, { title: 'Lyrics aligner' }))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(seen.outcome).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
    const error = seen.outcome as JobError
    expect(error).toBeInstanceOf(JobError)
    expect([error.code, error.retryable]).toEqual(['network', true])
    expect(error.message).toBe(
      'The download of the lyrics aligner isn’t arriving. Check your connection, then try again.',
    )
    // The request itself is aborted, so the browser drops it instead of waiting on.
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps waiting while bytes come in, and gives up 30 s after the last', async () => {
    const server = tricklingFetch()
    vi.stubGlobal('fetch', server.fetchMock)
    const { seen, settled } = watch(fetchModelFile({ url }))
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000)
      server.send(10)
    }
    await vi.advanceTimersByTimeAsync(29_000)
    expect(seen.outcome).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
    expect(seen.outcome).toBeInstanceOf(JobError)
    expect((seen.outcome as JobError).message).toBe(
      'The model download isn’t arriving. Check your connection, then try again.',
    )
  })

  it('gives the body 30 s for its first bytes once the server answers', async () => {
    const server = tricklingFetch({ answerLater: true })
    vi.stubGlobal('fetch', server.fetchMock)
    const { seen, settled } = watch(fetchModelFile({ url }))
    await vi.advanceTimersByTimeAsync(25_000)
    server.answer()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(seen.outcome).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
    expect((seen.outcome as JobError).code).toBe('network')
  })

  it('stops watching once the file is in', async () => {
    const server = tricklingFetch()
    vi.stubGlobal('fetch', server.fetchMock)
    const { seen, settled } = watch(fetchModelFile({ url }))
    await vi.advanceTimersByTimeAsync(1_000)
    server.send(10)
    server.end()
    await settled
    expect(seen.outcome).toBe('loaded')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is cancelled, not a download that is not arriving, when its job is cancelled while waiting', async () => {
    vi.stubGlobal('fetch', silentFetch())
    const cancel = new AbortController()
    const { seen, settled } = watch(fetchModelFile({ url }, { signal: cancel.signal }))
    await vi.advanceTimersByTimeAsync(10_000)
    cancel.abort()
    await settled
    expect((seen.outcome as JobError).code).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })
})

/** An in-memory stand-in for the browser's Cache Storage, returning what each URL holds. */
function memoryCaches(): Map<string, ArrayBuffer> {
  const store = new Map<string, ArrayBuffer>()
  const cache = {
    async match(url: string) {
      const b = store.get(url)
      return b ? new Response(b.slice(0)) : undefined
    },
    async put(url: string, response: Response) {
      store.set(url, await response.arrayBuffer())
    },
    async delete(url: string) {
      return store.delete(url)
    },
  }
  vi.stubGlobal('caches', { open: async () => cache })
  return store
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('fetchModelFile with a file cached under a former URL', () => {
  const latest = 'https://example.com/models/latest/m.tflite'
  const pinned = 'https://example.com/models/1/m.tflite'
  const bytes = new Uint8Array([5, 6, 7, 8])

  it('moves a copy with the same checksum to the pinned URL, without downloading', async () => {
    const store = memoryCaches()
    store.set(latest, bytes.slice().buffer)
    const fetchMock = vi.fn(async () => streamResponse([new Uint8Array([9])]))
    vi.stubGlobal('fetch', fetchMock)
    const stages: string[] = []
    const buf = await fetchModelFile(
      { url: pinned, sha256: await sha256(bytes), formerUrls: [latest] },
      { onProgress: (p) => stages.push(p.stage ?? '') },
    )
    expect([...new Uint8Array(buf)]).toEqual([...bytes])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stages).toEqual(['cached'])
    expect([...store.keys()]).toEqual([pinned])
  })

  it('downloads the file when the former copy has other bytes', async () => {
    const store = memoryCaches()
    store.set(latest, new Uint8Array([1, 2]).buffer)
    const fetchMock = vi.fn(async () => streamResponse([bytes]))
    vi.stubGlobal('fetch', fetchMock)
    const buf = await fetchModelFile({ url: pinned, sha256: await sha256(bytes), formerUrls: [latest] })
    expect([...new Uint8Array(buf)]).toEqual([...bytes])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect([...new Uint8Array(store.get(pinned)!)]).toEqual([...bytes])
  })
})
describe('thread policy', () => {
  it('uses one thread without isolation and leaves a core free, capped at 8, when isolated', () => {
    expect(wasmThreadCount(false, 16)).toBe(1)
    expect(wasmThreadCount(true, 1)).toBe(1)
    expect(wasmThreadCount(true, 4)).toBe(3)
    expect(wasmThreadCount(true, 32)).toBe(8)
  })

  it("lowers the count to the user's limit, never above the automatic count", () => {
    expect(wasmThreadCount(true, 8, 2)).toBe(2)
    expect(wasmThreadCount(true, 4, 6)).toBe(3)
    expect(wasmThreadCount(false, 8, 4)).toBe(1)
    expect(wasmThreadCount(true, 8, null)).toBe(7)
  })

  it('configures an onnxruntime env with an explicit thread count and no proxy', async () => {
    const env = { wasm: {} as { numThreads?: number; proxy?: boolean } }
    await expect(configureOnnxEnv(env, { numThreads: 3 })).resolves.toBe(3)
    expect(env.wasm).toEqual({ numThreads: 3, proxy: false })
  })
})

describe('model names in progress lines', () => {
  it('puts the title in a sentence with the size rounded to MB, and never says 0 MB', () => {
    expect(downloadingModel('Stem separator', 180_534_758)).toBe(
      'Downloading the stem separator (181 MB, once)',
    )
    expect(downloadingModel('Beat and bar tracker', 82_098_846)).toBe(
      'Downloading the beat and bar tracker (82 MB, once)',
    )
    expect(downloadingModel('Face finder', 230_000)).toBe('Downloading the face finder (under 1 MB, once)')
  })
})
