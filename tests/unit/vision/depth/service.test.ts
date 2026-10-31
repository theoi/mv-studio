import { describe, expect, it } from 'vitest'
import type { OnnxBackend } from '../../../../src/vision/backends.ts'
import {
  createDepthService,
  DEPTH_SHORT_SIDE,
  depthCacheKey,
  type DepthRequest,
} from '../../../../src/vision/depth/service.ts'
import { createMemoryCache } from '../../../../src/vision/runtime/cache.ts'
import type { CallOptions } from '../../../../src/shared/worker.ts'
import type { JobProgress as Progress } from '../../../../src/shared/jobs.ts'
import type { DepthQuality } from '../../../../src/vision/types.ts'

interface DepthCall {
  shortSide: number
  signal: AbortSignal | undefined
  closed: () => boolean
  resolve: () => void
  reject: (err: unknown) => void
}

/** Fake ONNX backend whose depth calls stay pending until the test releases them (or resolve at once). */
function fakeOnnx(options: { manual?: boolean; fail?: unknown } = {}) {
  const calls: DepthCall[] = []
  const onnx: Pick<OnnxBackend, 'depth'> = {
    depth(input, call: CallOptions = {}) {
      return new Promise((resolve, reject) => {
        const width = Math.round((input.shortSide * 16) / 9)
        const height = input.shortSide
        const data = new Uint8Array(width * height).map((_, i) => (i * 31 + input.shortSide) & 0xff)
        let closed = false
        const bitmap = input.bitmap as unknown as { close(): void }
        const done = () => {
          bitmap.close()
          closed = true
        }
        const entry: DepthCall = {
          shortSide: input.shortSide,
          signal: call.signal,
          closed: () => closed,
          resolve: () => {
            done()
            resolve({ width, height, data })
          },
          reject: (err) => {
            done()
            reject(err)
          },
        }
        call.signal?.addEventListener('abort', () => entry.reject(new DOMException('aborted', 'AbortError')))
        calls.push(entry)
        if (options.fail !== undefined) entry.reject(options.fail)
        else if (!options.manual) entry.resolve()
      })
    },
  }
  return { onnx: onnx as OnnxBackend, calls }
}

function request(quality: DepthQuality, extra: Partial<DepthRequest> = {}) {
  const frames: number[] = []
  const req: DepthRequest = {
    mediaId: 'clip-1',
    t: 1.5,
    quality,
    sourceSize: { width: 1920, height: 1080 },
    frame: async (maxSide) => {
      frames.push(maxSide)
      return { close() {} } as unknown as ImageBitmap
    },
    ...extra,
  }
  return { req, frames }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !pred(); i++) await tick()
  expect(pred()).toBe(true)
}

describe('depth service', () => {
  it('estimates at the quality short side, reports stages, and serves the next request from the cache', async () => {
    const { onnx, calls } = fakeOnnx()
    const cache = createMemoryCache()
    const service = createDepthService({ onnx, cache })
    const { req, frames } = request('preview')
    const progress: Progress[] = []
    const map = await service.get(req, { onProgress: (p) => progress.push(p) })

    expect(calls.map((c) => c.shortSide)).toEqual([DEPTH_SHORT_SIDE.preview])
    expect(DEPTH_SHORT_SIDE.preview % 14).toBe(0)
    expect(DEPTH_SHORT_SIDE.full % 14).toBe(0)
    expect(frames).toEqual([Math.ceil((364 * 1920) / 1080)])
    expect(calls[0]!.closed()).toBe(true)
    expect(map).toMatchObject({
      version: 1,
      width: 647,
      height: 364,
      quality: 'preview',
      sourceSize: { width: 1920, height: 1080 },
    })
    expect(map.model).toContain('depth-anything')
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining(['loading-frame', 'estimating-depth']),
    )
    expect(progress.at(-1)!.fraction).toBe(1)
    expect(await cache.get(depthCacheKey(req, 'preview'))).not.toBeNull()

    const again = await createDepthService({ onnx, cache }).get(request('preview').req)
    expect(calls).toHaveLength(1)
    expect(Array.from(again.data)).toEqual(Array.from(map.data))
    expect(again.width).toBe(map.width)
  })

  it('satisfies a preview with a cached full map, but not the other way round', async () => {
    const { onnx, calls } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    await service.get(request('full').req)
    const preview = await service.get(request('preview').req)
    expect(preview.quality).toBe('full')
    expect(calls.map((c) => c.shortSide)).toEqual([518])

    const other = createDepthService({ onnx, cache: createMemoryCache() })
    await other.get(request('preview').req)
    const full = await other.get(request('full').req)
    expect(full.quality).toBe('full')
    expect(calls.map((c) => c.shortSide)).toEqual([518, 364, 518])
  })

  it('keys the cache by media id and time', async () => {
    const { onnx, calls } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    await service.get(request('preview').req)
    await service.get(request('preview', { t: 1.5004 }).req)
    await service.get(request('preview', { t: 2 }).req)
    await service.get(request('preview', { mediaId: 'clip-2' }).req)
    expect(calls).toHaveLength(3)
    expect(depthCacheKey({ mediaId: 'a' }, 'preview')).toBe(depthCacheKey({ mediaId: 'a', t: 0 }, 'preview'))
  })

  it('shares one estimation between concurrent identical requests, and a preview joins a running full one', async () => {
    const { onnx, calls } = fakeOnnx({ manual: true })
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    const a = service.get(request('full').req)
    const b = service.get(request('full').req)
    const c = service.get(request('preview').req)
    await waitFor(() => calls.length === 1)
    calls[0]!.resolve()
    const [ma, mb, mc] = await Promise.all([a, b, c])
    expect(calls).toHaveLength(1)
    expect(mb).toBe(ma)
    expect(mc.quality).toBe('full')
  })

  it('cancelling one caller leaves the shared estimation running for the others', async () => {
    const { onnx, calls } = fakeOnnx({ manual: true })
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    const ctrl = new AbortController()
    const a = service.get(request('preview').req, { signal: ctrl.signal })
    const b = service.get(request('preview').req)
    await waitFor(() => calls.length === 1)
    ctrl.abort()
    await expect(a).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls[0]!.signal!.aborted).toBe(false)
    calls[0]!.resolve()
    await expect(b).resolves.toMatchObject({ quality: 'preview' })
  })

  it('aborts the estimation once every caller has cancelled, and a later request starts afresh', async () => {
    const { onnx, calls } = fakeOnnx({ manual: true })
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    const c1 = new AbortController()
    const c2 = new AbortController()
    const a = service.get(request('preview').req, { signal: c1.signal })
    const b = service.get(request('preview').req, { signal: c2.signal })
    await waitFor(() => calls.length === 1)
    c1.abort()
    expect(calls[0]!.signal!.aborted).toBe(false)
    c2.abort()
    expect(calls[0]!.signal!.aborted).toBe(true)
    await expect(a).rejects.toMatchObject({ code: 'cancelled' })
    await expect(b).rejects.toMatchObject({ code: 'cancelled' })

    const c = service.get(request('preview').req)
    await waitFor(() => calls.length === 2)
    calls[1]!.resolve()
    await expect(c).resolves.toMatchObject({ quality: 'preview' })
    expect(await service.peek(request('preview').req)).not.toBeNull()
  })

  it('rejects at once when the signal is already aborted, without grabbing a frame', async () => {
    const { onnx, calls } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    const { req, frames } = request('preview')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(service.get(req, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' })
    await tick()
    expect(frames).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('closes the frame when cancelled while it was being grabbed', async () => {
    const { onnx, calls } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    let release: () => void = () => {}
    let closed = false
    const ctrl = new AbortController()
    const { req } = request('preview', {
      frame: () =>
        new Promise<ImageBitmap>((resolve) => {
          release = () =>
            resolve({
              close() {
                closed = true
              },
            } as unknown as ImageBitmap)
        }),
    })
    const p = service.get(req, { signal: ctrl.signal })
    await tick()
    ctrl.abort()
    release()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    await waitFor(() => closed)
    expect(calls).toHaveLength(0)
  })

  it('maps backend errors to vision errors and does not cache failures', async () => {
    const failing = fakeOnnx({ fail: new Error('std::bad_alloc') })
    const cache = createMemoryCache()
    await expect(
      createDepthService({ onnx: failing.onnx, cache }).get(request('preview').req),
    ).rejects.toMatchObject({
      name: 'JobError',
      code: 'out-of-memory',
    })
    const ok = fakeOnnx()
    await createDepthService({ onnx: ok.onnx, cache }).get(request('preview').req)
    expect(ok.calls).toHaveLength(1)

    const badFrame = request('preview', { frame: () => Promise.reject(new Error('no frame')) }).req
    await expect(
      createDepthService({ onnx: ok.onnx, cache: createMemoryCache() }).get(badFrame),
    ).rejects.toMatchObject({ code: 'decode' })
  })

  it('rejects output whose size does not match its data', async () => {
    const onnx = {
      depth: async () => ({ width: 10, height: 10, data: new Uint8Array(50) }),
    } as unknown as OnnxBackend
    await expect(
      createDepthService({ onnx, cache: createMemoryCache() }).get(request('preview').req),
    ).rejects.toMatchObject({ code: 'internal' })
  })

  it('recomputes over a corrupt cache entry', async () => {
    const { onnx, calls } = fakeOnnx()
    const cache = createMemoryCache()
    await cache.put(depthCacheKey(request('preview').req, 'preview'), new Uint8Array([1, 2, 3]))
    const service = createDepthService({ onnx, cache })
    expect(await service.peek(request('preview').req)).toBeNull()
    await service.get(request('preview').req)
    expect(calls).toHaveLength(1)
  })

  it('peek returns the best cached map without computing', async () => {
    const { onnx, calls } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    const { frame: _frame, ...bare } = request('preview').req
    expect(await service.peek(bare)).toBeNull()
    expect(await service.peek({ ...bare, quality: 'full' })).toBeNull()
    await service.get(request('full').req)
    expect((await service.peek(bare))?.quality).toBe('full')
    expect(calls).toHaveLength(1)
  })

  it('rejects an invalid source size', async () => {
    const { onnx } = fakeOnnx()
    const service = createDepthService({ onnx, cache: createMemoryCache() })
    await expect(
      service.get(request('preview', { sourceSize: { width: 0, height: 10 } }).req),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})
