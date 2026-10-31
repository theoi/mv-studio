import { afterEach, describe, expect, it, vi } from 'vitest'
import { wasmThreadCount } from '../../../src/shared/capabilities.ts'
import { JobError } from '../../../src/shared/jobs.ts'
import { configureOnnxEnv, fetchModelFile } from '../../../src/shared/models.ts'

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
    expect(fractions).toEqual([0.3, 1])
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
