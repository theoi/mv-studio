import { describe, expect, it } from 'vitest'
import {
  clipEnergyLevel,
  frameHubness,
  rankClips,
  scoreSemantic,
} from '../../../../src/vision/matching/ranking.ts'
import type { ClipVisionIndex } from '../../../../src/vision/types.ts'
import { createRng, makeIndex, mix, randomUnit } from './helpers.ts'

const DIM = 64

/**
 * Concept clips are noisy copies of their concept. Text queries share a "generic" direction g with the reference
 * bank (as captions do in CLIP), and the hub clip sits near the mean of all concepts plus g, so it is close to
 * every query until hubness is subtracted.
 */
function hubWorld() {
  const rng = createRng(1234)
  const concepts = Array.from({ length: 5 }, () => randomUnit(DIM, rng))
  const g = randomUnit(DIM, rng)
  const reference = Array.from({ length: 24 }, () => mix([g], [1], 0.3, rng))
  const frames = (make: () => Float32Array) => Array.from({ length: 10 }, make)
  const conceptFrames = concepts.map((c) => frames(() => mix([c], [1], 0.25, rng)))
  const hubFrames = frames(() => mix([...concepts, g], [1, 1, 1, 1, 1, 3], 0.25, rng))
  const queries = concepts.map((c) => mix([c, g], [1, 1.5], 0.2, rng))

  const build = (withHubness: boolean): ClipVisionIndex[] => {
    const all = [...conceptFrames.map((f, k) => ({ id: `concept-${k}`, f })), { id: 'hub', f: hubFrames }]
    return all.map(({ id, f }) => {
      const index = makeIndex({ mediaId: id, frames: f })
      if (withHubness) index.hubness = frameHubness(index.embeddings, DIM, reference)
      return index
    })
  }
  return { build, queries }
}

function energyClip(id: string, meanEnergy: number, meanCamera = 0): ClipVisionIndex {
  return makeIndex({
    mediaId: id,
    frames: [randomUnit(DIM, createRng(id.length))],
    motion: { meanEnergy, meanCamera },
  })
}

describe('frameHubness', () => {
  it('is high for frames near the reference bank and near zero for unrelated frames', () => {
    const rng = createRng(9)
    const g = randomUnit(DIM, rng)
    const reference = [mix([g], [1], 0.2, rng), mix([g], [1], 0.2, rng)]
    const frames = new Float32Array(2 * DIM)
    frames.set(g, 0)
    frames.set(randomUnit(DIM, rng), DIM)
    const h = frameHubness(frames, DIM, reference)
    expect(h).toHaveLength(2)
    expect(h[0]).toBeGreaterThan(0.9)
    expect(Math.abs(h[1]!)).toBeLessThan(0.35)
  })
})

describe('hubness correction', () => {
  it('without correction the hub clip wins every query', () => {
    const { build, queries } = hubWorld()
    const library = build(false)
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(rankClips({ library, textVector: q })[0]!.mediaId).toBe('hub')
  })

  it('with correction each concept clip beats the hub for its own query', () => {
    const { build, queries } = hubWorld()
    const library = build(true)
    expect(queries.length).toBeGreaterThan(0)
    queries.forEach((q, k) => {
      const ranked = rankClips({ library, textVector: q })
      expect(ranked[0]!.mediaId).toBe(`concept-${k}`)
      const hubPos = ranked.findIndex((m) => m.mediaId === 'hub')
      const conceptPos = ranked.findIndex((m) => m.mediaId === `concept-${k}`)
      expect(conceptPos).toBeLessThan(hubPos)
    })
  })
})

describe('scoreSemantic', () => {
  it('finds the matching segment inside a longer clip', () => {
    const rng = createRng(77)
    const target = randomUnit(DIM, rng)
    const other = randomUnit(DIM, rng)
    const frames = Array.from({ length: 12 }, (_, t) =>
      t >= 5 && t <= 8 ? mix([target], [1], 0.3, rng) : mix([other], [1], 0.3, rng),
    )
    const index = makeIndex({ mediaId: 'long', frames, duration: 12 })
    const result = scoreSemantic(index, target, { duration: 3 })
    expect(result.bestRange.start).toBeCloseTo(5, 6)
    expect(result.bestRange.end).toBeCloseTo(8, 6)
    expect(result.frameScores).toHaveLength(12)
    // Top 40% = 5 frames: four matching frames plus one non-matching, so the score sits below a pure match.
    expect(result.score).toBeGreaterThan(0.5)
    expect(result.score).toBeLessThan(Math.min(...Array.from(result.frameScores.slice(5, 9))))
  })

  it('clamps the range to the clip duration', () => {
    const rng = createRng(78)
    const frames = [randomUnit(DIM, rng), randomUnit(DIM, rng)]
    const index = makeIndex({ mediaId: 'short', frames, times: [0, 1], duration: 1.5 })
    const { bestRange } = scoreSemantic(index, frames[1]!, { duration: 3 })
    expect(bestRange).toEqual({ start: 0, end: 1.5 })
  })

  it('subtracts hubness from frame scores', () => {
    const rng = createRng(79)
    const f = randomUnit(DIM, rng)
    const plain = scoreSemantic(makeIndex({ mediaId: 'a', frames: [f] }), f)
    const corrected = scoreSemantic(makeIndex({ mediaId: 'a', frames: [f], hubness: [0.4] }), f)
    expect(plain.score).toBeCloseTo(1, 5)
    expect(corrected.score).toBeCloseTo(0.6, 5)
  })
})

describe('rankClips energy', () => {
  const library = [
    energyClip('c', 6),
    energyClip('a', 1),
    energyClip('e', 20),
    energyClip('b', 3),
    energyClip('d', 10),
  ]

  it('orders clips by activity toward a high target', () => {
    expect(rankClips({ library, energy: 0.95 }).map((m) => m.mediaId)).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  it('orders clips by activity toward a low target', () => {
    const ranked = rankClips({ library, energy: 0.05 })
    expect(ranked.map((m) => m.mediaId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ranked.every((m) => m.components.semantic === null && m.components.mood === null)).toBe(true)
  })

  it('counts camera motion as weaker activity', () => {
    expect(clipEnergyLevel(energyClip('x', 2, 10))).toBeCloseTo(3.5, 6)
  })

  it('uses the mood energy prior to pull calm toward low-energy clips', () => {
    // The calm prior (0.15) sits between the two quietest clips' percentiles (0 and 0.25), closer to the second.
    const ranked = rankClips({ library, mood: 'calm' })
    expect(ranked.slice(0, 2).map((m) => m.mediaId)).toEqual(['b', 'a'])
    expect(ranked.at(-1)!.mediaId).toBe('e')
    expect(ranked[0]!.components.energy).not.toBeNull()
    const energetic = rankClips({ library, mood: 'energetic' })
    expect(energetic.slice(0, 2).map((m) => m.mediaId)).toEqual(['d', 'e'])
    expect(energetic.at(-1)!.mediaId).toBe('a')
  })

  it('leaves energy null for moods without a prior', () => {
    const ranked = rankClips({ library, mood: 'romantic' })
    expect(ranked.every((m) => m.components.energy === null && m.score === 0)).toBe(true)
    // Equal scores fall back to mediaId order.
    expect(ranked.map((m) => m.mediaId)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('picks the most active window when there is no text query', () => {
    const clip = makeIndex({
      mediaId: 'busy',
      frames: [randomUnit(DIM, createRng(5))],
      duration: 10,
      motion: { fps: 1, energy: [1, 1, 1, 1, 9, 9, 1, 1, 1], meanEnergy: 2.8 },
    })
    const [match] = rankClips({ library: [clip], energy: 0.9, duration: 1 })
    expect(match!.bestRange.start).toBeCloseTo(4.5, 6)
    expect(match!.bestRange.end).toBeCloseTo(5.5, 6)
  })

  it('picks the calmest window when the requested energy is low', () => {
    const clip = makeIndex({
      mediaId: 'mostly-busy',
      frames: [randomUnit(DIM, createRng(6))],
      duration: 10,
      motion: { fps: 1, energy: [9, 9, 9, 1, 1, 9, 9, 9, 9], meanEnergy: 7.2 },
    })
    const [match] = rankClips({ library: [clip], energy: 0.1, duration: 1 })
    expect(match!.bestRange.start).toBeCloseTo(3.5, 6)
    expect(match!.bestRange.end).toBeCloseTo(4.5, 6)
  })
})

describe('rankClips single-clip library', () => {
  it('produces finite scores with all components requested', () => {
    const rng = createRng(3)
    const clip = makeIndex({
      mediaId: 'only',
      frames: [randomUnit(DIM, rng), randomUnit(DIM, rng)],
      motion: { meanEnergy: 4 },
    })
    const [match] = rankClips({
      library: [clip],
      textVector: randomUnit(DIM, rng),
      moodVector: randomUnit(DIM, rng),
      mood: 'energetic',
    })
    expect(match!.components.semantic).toBe(0)
    expect(match!.components.mood).toBe(0)
    expect(Number.isFinite(match!.components.energy)).toBe(true)
    expect(Number.isFinite(match!.score)).toBe(true)
  })
})
