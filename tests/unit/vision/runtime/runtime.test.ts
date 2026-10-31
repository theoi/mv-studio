import { describe, expect, it } from 'vitest'
import { rleDecode, rleEncode } from '../../../../src/vision/mask/rle.ts'
import { decodeContainer, encodeContainer } from '../../../../src/vision/runtime/container.ts'
import { cacheKey, createMemoryCache } from '../../../../src/vision/runtime/cache.ts'
import { fitSize, sampleTimes } from '../../../../src/vision/runtime/frames.ts'
import { createProgress, subProgress } from '../../../../src/vision/runtime/tasks.ts'

function softMask(w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - w / 2, y - h / 2)
      d[y * w + x] = Math.max(0, Math.min(255, Math.round((40 - r) * 32)))
    }
  return d
}

describe('rle', () => {
  it('round-trips soft masks, random noise and edge cases', () => {
    const noise = new Uint8Array(1000)
    let s = 7
    for (let i = 0; i < noise.length; i++) noise[i] = s = (s * 1103515245 + 12345) & 0xff
    const cases = [
      softMask(256, 144),
      noise,
      new Uint8Array(0),
      new Uint8Array([5]),
      new Uint8Array(300).fill(255),
      new Uint8Array([1, 1, 2, 2, 2, 3]),
    ]
    for (const c of cases) expect(Array.from(rleDecode(rleEncode(c), c.length))).toEqual(Array.from(c))
  })

  it('compresses a typical soft mask well', () => {
    const m = softMask(256, 144)
    expect(rleEncode(m).length).toBeLessThan(m.length / 5)
  })

  it('rejects data that decodes to the wrong length', () => {
    expect(() => rleDecode(rleEncode(new Uint8Array(10)), 20)).toThrow()
  })
})

describe('container', () => {
  it('round-trips metadata and chunks, with and without compression', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array(0), softMask(64, 64)]
    for (const compress of [false, true]) {
      const bytes = await encodeContainer({ a: 1, name: 'x' }, chunks, { compress })
      const { meta, chunks: out } = await decodeContainer<{ a: number; name: string }>(bytes)
      expect(meta).toEqual({ a: 1, name: 'x' })
      expect(out.map((c) => Array.from(c))).toEqual(chunks.map((c) => Array.from(c)))
    }
  })

  it('compression shrinks redundant payloads', async () => {
    const big = new Uint8Array(100_000).fill(9)
    const plain = await encodeContainer({}, [big])
    const packed = await encodeContainer({}, [big], { compress: true })
    expect(packed.length).toBeLessThan(plain.length / 20)
  })

  it('rejects corrupt input', async () => {
    await expect(
      decodeContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    ).rejects.toThrow(/Corrupt/)
    const bytes = await encodeContainer({ a: 1 }, [new Uint8Array(50)])
    await expect(decodeContainer(bytes.subarray(0, bytes.length - 10))).rejects.toThrow(/truncated/)
  })
})

describe('cache', () => {
  it('keys are file-name safe, stable and distinguish parts', () => {
    const a = cacheKey('mask', 'media/1:2', 3)
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(cacheKey('mask', 'media/1:2', 3)).toBe(a)
    expect(cacheKey('mask', 'media/1:2', 4)).not.toBe(a)
    expect(cacheKey('mask', 'media-1-2', 3)).not.toBe(a)
  })

  it('memory cache stores copies', async () => {
    const c = createMemoryCache()
    const data = new Uint8Array([1, 2, 3])
    await c.put('k', data)
    data[0] = 9
    expect(Array.from((await c.get('k'))!)).toEqual([1, 2, 3])
    await c.delete('k')
    expect(await c.get('k')).toBeNull()
  })
})

describe('frames helpers', () => {
  it('sampleTimes spaces samples evenly and handles short ranges', () => {
    expect(sampleTimes(0, 1, 4)).toEqual([0, 0.25, 0.5, 0.75])
    expect(sampleTimes(2, 2.1, 1)).toEqual([2])
    expect(sampleTimes(1, 1, 10)).toEqual([])
    expect(sampleTimes(0, 10, 0)).toEqual([])
  })

  it('fitSize keeps aspect and limits the longer side', () => {
    expect(fitSize({ width: 1920, height: 1080 }, 256)).toEqual({ width: 256, height: 144 })
    expect(fitSize({ width: 1080, height: 1920 }, 256)).toEqual({ width: 144, height: 256 })
    expect(fitSize({ width: 200, height: 100 }, 256)).toEqual({ width: 200, height: 100 })
  })
})

describe('progress', () => {
  it('is monotonic, maps sub-ranges and always delivers 1', () => {
    const seen: number[] = []
    const report = createProgress((p) => seen.push(p.fraction ?? -1), 0)
    const sub = subProgress(report, 0.5, 1)
    report(0.2)
    report(0.1)
    sub(0.5)
    sub(1)
    expect(seen).toEqual([0.2, 0.75, 1])
  })
})
