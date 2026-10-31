import { describe, expect, it } from 'vitest'
import { SUITABILITY_VERSION } from '../../../../src/vision/mask/suitability.ts'
import { JobError } from '../../../../src/shared/jobs.ts'
import { createMemoryCache, type BlobCache } from '../../../../src/vision/runtime/cache.ts'
import { decodeContainer, encodeContainer } from '../../../../src/vision/runtime/container.ts'
import { createVisionService } from '../../../../src/vision/service.ts'
import type { VisionBackends } from '../../../../src/vision/backends.ts'
import type { SuitabilityReport } from '../../../../src/vision/types.ts'
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

  it('serves a selection track with its states from the cache, even from a new service', async () => {
    const selectDisc = (s: ReturnType<typeof setup>) => {
      s.seg.select = async (req) => {
        s.seg.calls.push('select')
        req.bitmap.close()
        const size = req.maskSize!
        return discMask(size, size.width / 2, size.height / 2, size.height / 4)
      }
      return s
    }
    const first = selectDisc(setup())
    const { source } = fakeSource({ duration: 1, frameRate: 10 })
    const click = { t: 0.5, points: [{ x: 0.5, y: 0.5 }] }
    const a = await first.service.selectionTrack(source, click, { fps: 10, maxSide: 64 })
    const second = selectDisc(setup(first.cache))
    const b = await second.service.selectionTrack(source, click, { fps: 10, maxSide: 64 })
    expect(count(second.seg.calls, 'select')).toBe(0)
    expect(a.states).toHaveLength(10)
    expect(b.states).toEqual(a.states)
    expect(b.confidence).toEqual(a.confidence)
    expect(b.spans).toEqual(a.spans)
    expect(b.track.packed).toEqual(a.track.packed)
    // A correction is a different request.
    const c = await second.service.selectionTrack(source, click, {
      fps: 10,
      maxSide: 64,
      corrections: [{ t: 0.9, points: [{ x: 0.5, y: 0.5 }] }],
    })
    expect(count(second.seg.calls, 'select')).toBeGreaterThan(0)
    expect(c.states).toHaveLength(10)
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

  describe('a stored person track report', () => {
    const stale: SuitabilityReport = {
      verdict: 'unsuitable',
      reasons: ['unstable-mask'],
      usableFraction: 0,
      meanCoverage: 0,
      stability: 0,
      sampledFrames: 1,
      suitableRanges: [],
    }
    /**
     * A cache holding one person track whose report is replaced by `stale`, without a version or with `version`, and
     * without detected people when `withPeople` is false (a file written before people detection), and without pop
     * shares when `withPops` is false (written before they were measured).
     */
    const storedWithReport = async (version?: number, withPeople = true, withPops = true) => {
      const cache = createMemoryCache()
      const { source } = fakeSource({ duration: 2, frameRate: 10 })
      let key = ''
      const spy: BlobCache = {
        get: (k) => {
          if (k.startsWith('person-track')) key = k
          return cache.get(k)
        },
        put: cache.put,
        delete: cache.delete,
      }
      await setup(spy).service.personTrack(source)
      const { meta, chunks } = await decodeContainer<Record<string, unknown>>((await cache.get(key))!)
      const { suitabilityVersion: _, people, ...rest } = meta
      const { pops: __, ...track } = rest.track as Record<string, unknown>
      await cache.put(
        key,
        await encodeContainer(
          {
            ...rest,
            ...(withPops ? {} : { track }),
            suitability: stale,
            ...(version ? { suitabilityVersion: version } : {}),
            ...(withPeople ? { people } : {}),
          },
          chunks,
        ),
      )
      const storedMeta = async () =>
        (await decodeContainer<Record<string, unknown>>((await cache.get(key))!)).meta
      const storedVersion = async () => (await storedMeta()).suitabilityVersion
      return { cache, source, storedVersion, storedMeta }
    }

    it('is judged again from the stored masks when older criteria judged it, and written back', async () => {
      const { cache, source, storedVersion } = await storedWithReport()
      const old = setup(cache)
      const judged = await old.service.personTrack(source)
      expect(count(old.seg.calls, 'beginTrack')).toBe(0)
      expect(count(old.seg.calls, 'analyze')).toBe(0)
      expect(judged.suitability.verdict).toBe('good')
      expect(await storedVersion()).toBe(SUITABILITY_VERSION)
      const current = await storedWithReport(SUITABILITY_VERSION)
      expect((await setup(current.cache).service.personTrack(current.source)).suitability).toEqual(stale)
    })

    it('finds the people in a track stored before people detection, without segmenting, and writes them back', async () => {
      const { cache, source, storedMeta } = await storedWithReport(undefined, false)
      const old = setup(cache)
      const judged = await old.service.personTrack(source)
      expect(count(old.seg.calls, 'beginTrack')).toBe(0)
      expect(old.seg.analyzed.length).toBe(10)
      expect(old.seg.analyzed.every((a) => a.people && !a.mask)).toBe(true)
      expect(judged.suitability.verdict).toBe('good')
      const meta = await storedMeta()
      expect(meta.suitabilityVersion).toBe(SUITABILITY_VERSION)
      expect(meta.people).toEqual(judged.people)
      const later = setup(cache)
      expect((await later.service.personTrack(source)).suitability).toEqual(judged.suitability)
      expect(later.seg.calls).toEqual([])
    })

    it('measures the pops of a track stored before they were kept, from every frame, and writes them back', async () => {
      const { cache, source, storedMeta } = await storedWithReport(undefined, true, false)
      const old = setup(cache)
      const judged = await old.service.personTrack(source)
      expect(count(old.seg.calls, 'beginTrack')).toBe(0)
      expect(old.seg.analyzed).toHaveLength(20)
      expect(old.seg.analyzed.every((a) => a.gray && !a.people && !a.mask)).toBe(true)
      expect(judged.suitability).toMatchObject({ verdict: 'good', stability: 1 })
      const meta = await storedMeta()
      expect(meta.suitabilityVersion).toBe(SUITABILITY_VERSION)
      expect((meta.track as { pops: number[] }).pops).toHaveLength(20)
      const later = setup(cache)
      await later.service.personTrack(source)
      expect(later.seg.calls).toEqual([])
    })

    it('keeps the stored masks when finding the people fails', async () => {
      const { cache, source } = await storedWithReport(undefined, false)
      const offline = setup(cache)
      offline.seg.analyze = async (req) => {
        req.bitmap.close()
        throw new JobError('model-load', 'offline')
      }
      await expect(offline.service.personTrack(source)).rejects.toMatchObject({ code: 'model-load' })
      const online = setup(cache)
      expect((await online.service.personTrack(source)).suitability.verdict).toBe('good')
      expect(count(online.seg.calls, 'beginTrack')).toBe(0)
    })

    it('is judged again with the caller’s criteria', async () => {
      const { cache, source } = await storedWithReport()
      const strict = await setup(cache).service.cachedPersonTrack(source, {
        suitability: { minSubjectHeight: 0.99 },
      })
      expect(strict?.suitability.verdict).toBe('unsuitable')
    })

    it('is left alone when only its observations are read for subject tracking', async () => {
      const { cache, source, storedVersion } = await storedWithReport()
      const s = setup(cache)
      const subjects = await s.service.subjects(source)
      expect(count(s.seg.calls, 'analyze')).toBe(0)
      expect(subjects.samples.length).toBe(10)
      expect(await storedVersion()).toBeUndefined()
    })
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
