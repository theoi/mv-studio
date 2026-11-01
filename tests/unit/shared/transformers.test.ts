import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerModelFiles, sharedFetch } from '../../../src/shared/transformers.ts'

afterEach(() => vi.unstubAllGlobals())

describe('sharedFetch', () => {
  it('checks a registered file against its checksum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    )
    const url = 'https://huggingface.co/x/y/resolve/0123456789abcdef0123456789abcdef01234567/config.json'
    registerModelFiles([{ url, sha256: '00'.repeat(32) }])
    await expect(sharedFetch(url)).rejects.toThrow(/Checksum mismatch/)
    const other = 'https://huggingface.co/x/y/resolve/0123456789abcdef0123456789abcdef01234567/other.json'
    expect((await sharedFetch(other)).status).toBe(200)
  })
})
