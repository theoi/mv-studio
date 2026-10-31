import { describe, expect, it } from 'vitest'
import { PEOPLE_VERSION, SUITABILITY_VERSION } from '../../../../src/vision/mask/suitability.ts'
import { JobError } from '../../../../src/shared/jobs.ts'
import { createMemoryCache, type BlobCache } from '../../../../src/vision/runtime/cache.ts'
import { decodeContainer, encodeContainer } from '../../../../src/vision/runtime/container.ts'
import { createVisionService } from '../../../../src/vision/service.ts'
import type { PersonDetection, VisionBackends } from '../../../../src/vision/backends.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import type { Mask, PackedMaskTrack, Size, SuitabilityReport } from '../../../../src/vision/types.ts'
import { discMask, fakeOnnx, fakeSegmentation, fakeSource, flatGray } from '../segmentation/fakes.ts'

/** `detectors: 'unavailable'` stands for a person and face detector that cannot be downloaded. */
function setup(cache: BlobCache = createMemoryCache(), detectors: 'available' | 'unavailable' = 'available') {
  const whole = (): PersonDetection[] => [{ box: { x: 0, y: 0, width: 1, height: 1 }, score: 0.9 }]
  const seg = fakeSegmentation(
    (_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 3),
    detectors === 'available' ? whole : () => null,
    { facesUnavailable: detectors === 'unavailable' },
  )
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

    it('is judged again from the stored masks, with the people found again, when an older version judged it', async () => {
      const { cache, source, storedVersion, storedMeta } = await storedWithReport(PEOPLE_VERSION - 1)
      const old = setup(cache)
      const judged = await old.service.personTrack(source)
      expect(count(old.seg.calls, 'beginTrack')).toBe(0)
      // An older detection did not look for animals, so the people are looked for again, without segmenting, and the
      // masks are cut down to the parts near them, which needs every frame's luma.
      expect(old.seg.analyzed).toHaveLength(20)
      expect(old.seg.analyzed.filter((a) => a.people)).toHaveLength(10)
      expect(old.seg.analyzed.every((a) => a.gray && !a.mask)).toBe(true)
      expect(judged.suitability.verdict).toBe('good')
      expect(await storedVersion()).toBe(SUITABILITY_VERSION)
      expect((await storedMeta()).people).toEqual(judged.people)
      const current = await storedWithReport(SUITABILITY_VERSION)
      expect((await setup(current.cache).service.personTrack(current.source)).suitability).toEqual(stale)
    })

    it.runIf(PEOPLE_VERSION < SUITABILITY_VERSION)(
      'is judged again from the stored masks and people, without segmenting or detecting, when only the judging changed',
      async () => {
        const { cache, source, storedVersion, storedMeta } = await storedWithReport(PEOPLE_VERSION)
        const { people } = await storedMeta()
        const later = setup(cache)
        const judged = await later.service.personTrack(source)
        expect(later.seg.calls).toEqual([])
        expect(later.seg.analyzed).toEqual([])
        expect(judged.suitability.verdict).toBe('good')
        expect(judged.people).toEqual(people)
        expect(await storedVersion()).toBe(SUITABILITY_VERSION)
      },
    )

    it('finds the people in a track stored before people detection, without segmenting, and writes them back', async () => {
      const { cache, source, storedMeta } = await storedWithReport(undefined, false)
      const old = setup(cache)
      const judged = await old.service.personTrack(source)
      expect(count(old.seg.calls, 'beginTrack')).toBe(0)
      expect(old.seg.analyzed.length).toBe(20)
      expect(old.seg.analyzed.filter((a) => a.people)).toHaveLength(10)
      expect(old.seg.analyzed.every((a) => a.gray && !a.mask)).toBe(true)
      expect(judged.suitability.verdict).toBe('good')
      const meta = await storedMeta()
      expect(meta.suitabilityVersion).toBe(SUITABILITY_VERSION)
      expect(meta.people).toEqual(judged.people)
      const later = setup(cache)
      expect((await later.service.personTrack(source)).suitability).toEqual(judged.suitability)
      expect(later.seg.calls).toEqual([])
    })

    it('measures the pops of a track stored before they were kept, from every frame, and writes them back', async () => {
      const { cache, source, storedMeta } = await storedWithReport(SUITABILITY_VERSION, true, false)
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
        throw new JobError('worker-crashed', 'crashed')
      }
      await expect(offline.service.personTrack(source)).rejects.toMatchObject({ code: 'worker-crashed' })
      const online = setup(cache)
      expect((await online.service.personTrack(source)).suitability.verdict).toBe('good')
      expect(count(online.seg.calls, 'beginTrack')).toBe(0)
    })

    it('is judged on its whole mask when the person detector cannot be downloaded, and looked at again later', async () => {
      const { cache, source, storedMeta } = await storedWithReport(undefined, false)
      const offline = setup(cache, 'unavailable')
      const judged = await offline.service.personTrack(source)
      expect(judged.suitability).toMatchObject({ verdict: 'good', peopleSkipped: true })
      expect(count(offline.seg.calls, 'beginTrack')).toBe(0)
      expect(offline.seg.analyzed).toHaveLength(1)
      const meta = await storedMeta()
      expect(meta.people).toBeUndefined()
      expect(meta.suitabilityVersion).toBeUndefined()
      const online = setup(cache)
      const later = await online.service.personTrack(source)
      expect(later.suitability.peopleSkipped).toBeUndefined()
      expect(later.people).toHaveLength(10)
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
  it('builds a track without the detectors when they cannot be downloaded, and finds the people in it later', async () => {
    const offline = setup(createMemoryCache(), 'unavailable')
    const { source } = fakeSource({ duration: 2, frameRate: 10 })
    const built = await offline.service.personTrack(source)
    expect(built.suitability).toMatchObject({ verdict: 'good', peopleSkipped: true })
    const online = setup(offline.cache)
    const later = await online.service.personTrack(source)
    expect(count(online.seg.calls, 'beginTrack')).toBe(0)
    expect(online.seg.analyzed.filter((a) => a.people)).toHaveLength(10)
    expect(later.suitability.peopleSkipped).toBeUndefined()
    expect(later.track.packed).toEqual(built.track.packed)
    // The observations have no faces, so subject tracking looks again instead of reusing them.
    const subjects = await online.service.subjects(source)
    expect(subjects.samples[0]!.source).toBe('face')
  })

  it('cuts the whole masks of a track built without the detectors down to the parts near the people once found', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 10 })
    // A person on the left and, apart from them, an animal on the right; the detector finds only the person.
    const scene = (_t: number, s: Size): Mask => {
      const m = discMask(s, s.width * 0.3, s.height / 2, s.height / 4)
      const animal = discMask(s, s.width * 0.75, s.height / 2, s.height / 6)
      for (let i = 0; i < m.data.length; i++) m.data[i] = Math.max(m.data[i]!, animal.data[i]!)
      return m
    }
    const person = (): PersonDetection[] => [
      { box: { x: 0.15, y: 0.2, width: 0.3, height: 0.6 }, score: 0.9 },
    ]
    const make = (cache: BlobCache, online: boolean) => {
      const seg = fakeSegmentation(scene, online ? person : () => null, { facesUnavailable: !online })
      const onnx = fakeOnnx({ dim: 8 })
      const backends: VisionBackends = { segmentation: () => seg, onnx: () => onnx }
      return { seg, service: createVisionService({ backends, cache, toGray: (_b, size) => flatGray(size) }) }
    }
    const cache = createMemoryCache()
    const built = await make(cache, false).service.personTrack(source)
    const online = make(cache, true)
    const later = await online.service.personTrack(source)
    expect(count(online.seg.calls, 'beginTrack')).toBe(0)
    const { width, height } = built.track.meta.maskSize
    const at = (track: PackedMaskTrack, x: number) =>
      createTrackReader(track).frame(10).data[Math.round(height / 2) * width + Math.round(width * x)]
    expect([at(built.track, 0.3), at(built.track, 0.75)]).toEqual([255, 255])
    expect([at(later.track, 0.3), at(later.track, 0.75)]).toEqual([255, 0])
    expect(later.track.meta.pops).toHaveLength(20)
    // Subject tracking's person boxes follow the kept masks.
    const right = (o: (typeof later.observations)[number]) => o.personBox!.x + o.personBox!.width
    expect(right(built.observations[0]!)).toBeGreaterThan(0.75)
    expect(right(later.observations[0]!)).toBeLessThan(0.5)
    const again = make(cache, true)
    expect((await again.service.personTrack(source)).track.packed).toEqual(later.track.packed)
    expect(again.seg.calls).toEqual([])
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
