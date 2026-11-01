import { describe, expect, it } from 'vitest'
import {
  deserializeClipIndex,
  indexClip,
  samplePeakLuma,
  serializeClipIndex,
} from '../../../../src/vision/matching/indexer.ts'
import type { Size } from '../../../../src/vision/types.ts'
import { fakeOnnx, fakeSource, flatGray, timeOf } from '../segmentation/fakes.ts'

const DIM = 8
const basis = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === k ? 1 : 0))

describe('indexClip', () => {
  it('embeds ~1 frame per second in batches, computes hubness and motion, and closes every frame', async () => {
    const { source, opened } = fakeSource({ duration: 10, width: 640, height: 360 })
    // Frames before t = 5 look like the reference prompt (axis 0), later frames like axis 1.
    const onnx = fakeOnnx({ dim: DIM, imageVector: (t) => basis(t < 5 ? 0 : 1) })
    const index = await indexClip(
      {
        onnx,
        model: 'clipB32',
        toGray: (_b, size: Size) => flatGray(size),
        referenceVectors: async () => [basis(0)],
      },
      source,
      { batchSize: 4 },
    )
    expect(index.times).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(index.dim).toBe(DIM)
    expect(onnx.calls.embedImages).toEqual([4, 4, 2])
    expect(index.hubness).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0])
    expect(index.motion.fps).toBe(4)
    expect(index.motion.energy).toHaveLength(39)
    expect(opened.length).toBe(40)
    expect(opened.every((b) => (b as unknown as { closed: boolean }).closed)).toBe(true)
  })

  it('measures the brightest pixel at the decoded size, so a small light on black still counts', async () => {
    const run = (toGray: (b: ImageBitmap, s: Size) => ReturnType<typeof flatGray>) =>
      indexClip(
        { onnx: fakeOnnx({ dim: DIM }), model: 'clipB32', toGray, referenceVectors: async () => [] },
        fakeSource({ duration: 2, width: 1920, height: 1080 }).source,
      )
    expect((await run((_b, s) => flatGray(s, 0))).motion.peakLuma).toBe(0)
    // A 3 px light that the 64 px motion frame samples away.
    const light = await run((b, s) => {
      const gray = flatGray(s, 0)
      if (s.width === b.width && s.height === b.height)
        for (let y = 100; y < 103; y++) gray.data.fill(230, y * s.width + 150, y * s.width + 153)
      return gray
    })
    expect(light.motion.peakLuma).toBe(230)
  })

  it('round-trips through the cache format', async () => {
    const { source } = fakeSource({ duration: 3 })
    const onnx = fakeOnnx({ dim: DIM })
    const index = await indexClip(
      { onnx, model: 'clipB32', toGray: (_b, s) => flatGray(s), referenceVectors: async () => [] },
      source,
    )
    const back = await deserializeClipIndex(await serializeClipIndex(index))
    expect(back).toEqual(index)
  })

  it('fails with the embedding error and closes every frame', async () => {
    const { source, opened } = fakeSource({ duration: 4 })
    const onnx = fakeOnnx({ dim: DIM })
    onnx.embedImages = async ({ bitmaps }) => {
      for (const b of bitmaps) b.close()
      throw new Error('bad_alloc')
    }
    await expect(
      indexClip(
        { onnx, model: 'clipB32', toGray: (_b, s) => flatGray(s), referenceVectors: async () => [] },
        source,
        {
          batchSize: 2,
        },
      ),
    ).rejects.toMatchObject({ code: 'out-of-memory' })
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((b) => (b as unknown as { closed: boolean }).closed)).toBe(true)
  })
})

describe('samplePeakLuma', () => {
  const closed = (bitmaps: ImageBitmap[]) =>
    bitmaps.every((b) => (b as unknown as { closed: boolean }).closed)

  it('reads the first frame and 8 spread over the clip at the matching size, so a light in any of them counts', async () => {
    const { source, opened } = fakeSource({ duration: 10, width: 3840, height: 2160 })
    const sizes: Size[] = []
    // Black except a 2 px light in the frame at 6.875 s, the sixth of the 8.
    const toGray = (b: ImageBitmap, s: Size) => {
      sizes.push(s)
      const gray = flatGray(s, 4)
      if (timeOf(b) === 6.875) gray.data.fill(200, 10, 12)
      return gray
    }
    expect(await samplePeakLuma({ toGray }, source)).toBe(200)
    expect(opened.map(timeOf)).toEqual([0, 0.625, 1.875, 3.125, 4.375, 5.625, 6.875, 8.125, 9.375])
    expect(sizes[0]).toEqual({ width: 399, height: 224 })
    expect(closed(opened)).toBe(true)
    expect(await samplePeakLuma({ toGray }, fakeSource({ duration: 10 }).source, { frames: 4 })).toBe(4)
  })

  it('stops at the first frame bright enough, so a clip that shows something costs a frame or two', async () => {
    // Fades in from black: the first frame is dark, the rest bright.
    const toGray = (b: ImageBitmap, s: Size) => flatGray(s, timeOf(b) === 0 ? 2 : 90)
    const fading = fakeSource({ duration: 10 })
    expect(await samplePeakLuma({ toGray }, fading.source, { enough: 16 })).toBe(90)
    expect(fading.opened.map(timeOf)).toEqual([0, 0.625])
    expect(closed(fading.opened)).toBe(true)
    const bright = fakeSource({ duration: 10 })
    await samplePeakLuma({ toGray: (_b, s) => flatGray(s, 60) }, bright.source, { enough: 16 })
    expect(bright.opened).toHaveLength(1)
    // A clip that shows nothing is read in full.
    const black = fakeSource({ duration: 10 })
    expect(await samplePeakLuma({ toGray: (_b, s) => flatGray(s, 3) }, black.source, { enough: 16 })).toBe(3)
    expect(black.opened).toHaveLength(9)
  })

  it('reads a still once', async () => {
    const { source, opened } = fakeSource({ duration: 0 })
    expect(await samplePeakLuma({ toGray: (_b, s) => flatGray(s, 0) }, source)).toBe(0)
    expect(opened).toHaveLength(1)
  })

  it('fails as a decode error, and stops when cancelled', async () => {
    const broken = fakeSource({ duration: 10, failAt: 5 })
    await expect(samplePeakLuma({ toGray: (_b, s) => flatGray(s) }, broken.source)).rejects.toMatchObject({
      code: 'decode',
    })
    expect(closed(broken.opened)).toBe(true)
    const stop = new AbortController()
    stop.abort()
    await expect(
      samplePeakLuma({ toGray: (_b, s) => flatGray(s) }, fakeSource({ duration: 10 }).source, {
        signal: stop.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})
