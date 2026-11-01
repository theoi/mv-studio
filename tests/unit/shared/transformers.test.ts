import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pinRevision,
  registerModelFiles,
  sharedFetch,
  withModelProgress,
} from '../../../src/shared/transformers.ts'

afterEach(() => vi.unstubAllGlobals())

describe('sharedFetch', () => {
  it('checks a registered file against its checksum, also where Transformers.js asks for it at main', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    )
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const base = `https://huggingface.co/x/y/resolve/${revision}/`
    pinRevision('x/y', revision)
    registerModelFiles([{ url: `${base}config.json`, sha256: '00'.repeat(32) }])
    await expect(sharedFetch(`${base}config.json`)).rejects.toThrow(/Checksum mismatch/)
    await expect(sharedFetch('https://huggingface.co/x/y/resolve/main/config.json')).rejects.toThrow(
      /Checksum mismatch/,
    )
    expect((await sharedFetch(`${base}other.json`)).status).toBe(200)
  })

  it('answers a missing file with its status, but throws it as a failed download for a registered file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    )
    const revision = '89abcdef0123456789abcdef0123456789abcdef'
    const base = `https://huggingface.co/x/z/resolve/${revision}/`
    registerModelFiles([{ url: `${base}onnx/model.onnx`, sha256: '00'.repeat(32) }])
    expect((await sharedFetch(`${base}tokenizer.json`)).status).toBe(404)
    await expect(sharedFetch(`${base}onnx/model.onnx`)).rejects.toMatchObject({
      code: 'model-load',
      retryable: false,
    })
  })

  it('throws a server in trouble as a failed download naming the model, for any file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    )
    const url = 'https://huggingface.co/x/v/resolve/main/config.json'
    const load = withModelProgress(undefined, () => sharedFetch(url), 'Lyrics transcriber')
    await expect(load).rejects.toMatchObject({
      code: 'model-load',
      retryable: true,
      message:
        'Couldn’t download the lyrics transcriber. The server is having trouble. Try again in a few minutes.',
      details: { url, status: 503 },
    })
  })
})

describe('a required file Transformers.js finds missing', () => {
  /** What Transformers.js throws for a required file answered 401, 403 or 404 (its hub's `handleError`). */
  const missing = (status: number) =>
    Object.assign(
      new Error(`Forbidden access to file: "https://huggingface.co/x/w/resolve/main/config.json".`),
      { name: 'ModelFileNotFoundError', status },
    )

  it('fails as the loader’s download error naming the model, keeping Transformers.js’s message in the details', async () => {
    const error = missing(403)
    const load = withModelProgress(undefined, () => Promise.reject(error), 'Lyrics transcriber')
    await expect(load).rejects.toMatchObject({
      code: 'model-load',
      retryable: false,
      message:
        'Couldn’t download the lyrics transcriber. The server didn’t send the file. Reload the page to get the latest MV Studio, then try again.',
      details: { status: 403, message: error.message },
    })
  })

  it('passes on unchanged without a title, and other errors with one', async () => {
    const error = missing(404)
    await expect(withModelProgress(undefined, () => Promise.reject(error))).rejects.toBe(error)
    const session = new Error('failed to create session')
    await expect(
      withModelProgress(undefined, () => Promise.reject(session), 'Lyrics transcriber'),
    ).rejects.toBe(session)
  })
})

describe('a model download through sharedFetch that gets no bytes', () => {
  afterEach(() => vi.useRealTimers())

  it('names the model the call loads', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const load = withModelProgress(
      undefined,
      () => sharedFetch('https://huggingface.co/x/w/resolve/main/onnx/encoder_model.onnx'),
      'Lyrics transcriber',
    ).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await load).toMatchObject({
      code: 'network',
      message: 'The download of the lyrics transcriber isn’t arriving. Check your connection and try again.',
    })
  })
})
