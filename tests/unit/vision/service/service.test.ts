import { describe, expect, it } from 'vitest'
import { createMemoryCache, type BlobCache } from '../../../../src/vision/runtime/cache.ts'
import { createVisionService } from '../../../../src/vision/service.ts'
import type { VisionBackends } from '../../../../src/vision/backends.ts'
import { discMask, fakeOnnx, fakeSegmentation, fakeSource, flatGray } from '../segmentation/fakes.ts'

function setup(cache: BlobCache = createMemoryCache()) {
  const seg = fakeSegmentation((_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 3))
  const onnx = fakeOnnx({ dim: 8 })
  const backends: VisionBackends = { segmentation: () => seg, onnx: () => onnx }
  const service = createVisionService({ backends, cache, toGray: (_b, size) => flatGray(size) })
  return { seg, onnx, service, cache }
}

const count = (calls: string[], name: string) => calls.filter((c) => c === name).length

describe('vision service', () => {
  it('serves a person track from the cache on later requests, even from a new service', async () => {
    const first = setup()
    const { source } = fakeSource({ duration: 1, frameRate: 10 })
    const a = await first.service.personTrack(source)
    const second = setup(first.cache)
    const b = await second.service.personTrack(source)
    expect(count(first.seg.calls, 'beginTrack')).toBe(1)
    expect(count(second.seg.calls, 'beginTrack')).toBe(0)
    expect(b.track.meta).toEqual(a.track.meta)
    expect(b.track.packed).toEqual(a.track.packed)
    expect(b.observations).toEqual(a.observations)
  })

  it('computes concurrent identical requests once', async () => {
    const { service, seg } = setup()
    const { source } = fakeSource({ duration: 1, frameRate: 10 })
    await Promise.all([service.personTrack(source), service.personTrack(source)])
    expect(count(seg.calls, 'beginTrack')).toBe(1)
  })

  it('recomputes when the cached entry is corrupt', async () => {
    const cache = createMemoryCache()
    const first = setup(cache)
    const { source } = fakeSource({ duration: 1, frameRate: 10 })
    await first.service.personTrack(source)
    const store = cache as BlobCache & { put: BlobCache['put'] }
    const keys: string[] = []
    const spy: BlobCache = {
      get: async (k) => {
        keys.push(k)
        return new Uint8Array([1, 2, 3])
      },
      put: store.put,
      delete: store.delete,
    }
    const second = setup(spy)
    await second.service.personTrack(source)
    expect(keys.length).toBe(1)
    expect(count(second.seg.calls, 'beginTrack')).toBe(1)
  })

  it('reuses the cached person track observations for subject tracking', async () => {
    const { service, seg } = setup()
    const { source } = fakeSource({ duration: 2, frameRate: 10 })
    await service.personTrack(source)
    const subjects = await service.subjects(source)
    expect(count(seg.calls, 'analyze')).toBe(0)
    expect(subjects.samples.length).toBe(10)
    expect(subjects.samples[0]!.source).toBe('face')
  })

  it('caches clip indexes per embedding model', async () => {
    const { service, onnx } = setup()
    const { source } = fakeSource({ duration: 3 })
    const a = await service.indexClip(source)
    const b = await service.indexClip(source)
    expect(b).toEqual(a)
    expect(onnx.calls.embedImages.length).toBe(1)
  })
})
