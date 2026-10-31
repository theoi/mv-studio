import { describe, expect, it } from 'vitest'
import {
  cosineToAll,
  dot,
  frameVector,
  meanVector,
  normalize,
} from '../../../../src/vision/matching/embeddings.ts'
import { queryVariants } from '../../../../src/vision/matching/prompts.ts'
import { createRng, makeIndex, randomUnit } from './helpers.ts'

describe('embeddings', () => {
  it('normalizes to unit length and keeps zero vectors zero', () => {
    const v = normalize(new Float32Array([3, 4]))
    expect(Array.from(v)).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)])
    expect(Array.from(normalize(new Float32Array(3)))).toEqual([0, 0, 0])
  })

  it('dots with offsets', () => {
    const a = new Float32Array([1, 2, 3, 4])
    const b = new Float32Array([0, 10, 100])
    expect(dot(a, b, 2, 1, 2)).toBe(3 * 10 + 4 * 100)
  })

  it('meanVector returns the normalized mean', () => {
    const m = meanVector([new Float32Array([1, 0]), new Float32Array([0, 1])])
    expect(m[0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(m[1]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('cosineToAll matches per-frame cosine and normalizes the query', () => {
    const rng = createRng(7)
    const frames = [randomUnit(16, rng), randomUnit(16, rng), randomUnit(16, rng)]
    const index = makeIndex({ mediaId: 'a', frames })
    const q = randomUnit(16, rng).map((x) => x * 5)
    const sims = cosineToAll(index, q)
    expect(sims).toHaveLength(3)
    expect(Array.from(frameVector(index, 1))).toEqual(Array.from(frames[1]!))
    frames.forEach((f, i) => expect(sims[i]).toBeCloseTo(dot(f, q) / 5, 5))
  })
})

describe('queryVariants', () => {
  it('returns the trimmed text plus templates, and nothing for blank text', () => {
    const variants = queryVariants('  rain at night ')
    expect(variants[0]).toBe('rain at night')
    expect(variants.length).toBeGreaterThanOrEqual(3)
    expect(variants.slice(1).every((v) => v.includes('rain at night') && v !== 'rain at night')).toBe(true)
    expect(queryVariants('   ')).toEqual([])
  })
})
