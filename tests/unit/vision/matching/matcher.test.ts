import { describe, expect, it } from 'vitest'
import { createFootageMatcher } from '../../../../src/vision/matching/matcher.ts'
import { REFERENCE_PROMPTS } from '../../../../src/vision/matching/prompts.ts'
import { makeIndex } from './helpers.ts'

const DIM = 8
const basis = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === k ? 1 : 0))

/** Texts mentioning "rain" embed on axis 2, "dance" on axis 3; others fall back to the fake's hash vectors. */
const textVector = (t: string) => (t.includes('rain') ? basis(2) : t.includes('dance') ? basis(3) : basis(7))

function library(model = 'clipB32') {
  return [
    { ...makeIndex({ mediaId: 'rainy', frames: [basis(2), basis(2), basis(4)] }), model },
    { ...makeIndex({ mediaId: 'party', frames: [basis(3), basis(3), basis(3)] }), model },
    { ...makeIndex({ mediaId: 'other', frames: [basis(5), basis(6), basis(5)] }), model },
  ]
}

describe('footage matcher', () => {
  it('ranks the clip that shows the lyric line first, with its best range', async () => {
    const { fakeOnnx } = await import('../segmentation/fakes.ts')
    const matcher = createFootageMatcher({ onnx: fakeOnnx({ dim: DIM, textVector }), model: 'clipB32' })
    const ranked = await matcher.rank(library(), { text: 'walking in the rain', duration: 1 })
    expect(ranked[0]!.mediaId).toBe('rainy')
    expect(ranked[0]!.bestRange.start).toBeLessThan(2)
    const dance = await matcher.rank(library(), { text: 'we dance all night' })
    expect(dance[0]!.mediaId).toBe('party')
  })

  it('embeds each text once and batches many queries into one call', async () => {
    const { fakeOnnx } = await import('../segmentation/fakes.ts')
    const onnx = fakeOnnx({ dim: DIM, textVector })
    const matcher = createFootageMatcher({ onnx, model: 'clipB32' })
    await matcher.rankAll(library(), [{ text: 'rain' }, { text: 'dance' }, { text: 'rain', mood: 'calm' }])
    expect(onnx.calls.embedTexts).toHaveLength(1)
    await matcher.rank(library(), { text: 'rain' })
    expect(onnx.calls.embedTexts).toHaveLength(1)
  })

  it('ignores clips indexed with another embedding model', async () => {
    const { fakeOnnx } = await import('../segmentation/fakes.ts')
    const matcher = createFootageMatcher({ onnx: fakeOnnx({ dim: DIM, textVector }), model: 'clipB32' })
    const mixed = [...library('clipB32').slice(1), ...library('siglipB16').slice(0, 1)]
    const ranked = await matcher.rank(mixed, { text: 'rain' })
    expect(ranked.map((m) => m.mediaId).sort()).toEqual(['other', 'party'])
  })

  it('provides one cached reference vector per hubness prompt', async () => {
    const { fakeOnnx } = await import('../segmentation/fakes.ts')
    const onnx = fakeOnnx({ dim: DIM })
    const matcher = createFootageMatcher({ onnx, model: 'clipB32' })
    const refs = await matcher.referenceVectors()
    await matcher.referenceVectors()
    expect(refs).toHaveLength(REFERENCE_PROMPTS.length)
    expect(onnx.calls.embedTexts).toHaveLength(1)
  })
})
