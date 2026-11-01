import { afterEach, describe, expect, it, vi } from 'vitest'
import { pinRevision, registerModelFiles, sharedFetch } from '../../../src/shared/transformers.ts'

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

  it('answers an error status with that status, but throws it as a failed download for a registered file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    )
    const revision = '89abcdef0123456789abcdef0123456789abcdef'
    const base = `https://huggingface.co/x/z/resolve/${revision}/`
    registerModelFiles([{ url: `${base}onnx/model.onnx`, sha256: '00'.repeat(32) }])
    expect((await sharedFetch(`${base}tokenizer.json`)).status).toBe(503)
    await expect(sharedFetch(`${base}onnx/model.onnx`)).rejects.toMatchObject({
      code: 'model-load',
      retryable: true,
    })
  })
})
