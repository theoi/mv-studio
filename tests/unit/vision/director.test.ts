import { describe, expect, it } from 'vitest'
import { buildVisualAnalysis } from '../../../src/vision/analysisData.ts'
import { createDirectorFootageMatcher } from '../../../src/vision/director.ts'
import { createFootageMatcher } from '../../../src/vision/matching/matcher.ts'
import type { Project } from '../../../src/model/types.ts'
import type { ClipVisionIndex } from '../../../src/vision/types.ts'
import { fakeOnnx } from './segmentation/fakes.ts'

const DIM = 8
const basis = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === k ? 1 : 0))
// "rain" captions on axis 2, "dancing" on axis 3, "city" on axis 4; every other caption on a random direction.
const textVector = (t: string) =>
  /rain|wet/.test(t) ? basis(2) : /danc/.test(t) ? basis(3) : /city|urban/.test(t) ? basis(4) : undefined

function clip(id: string, frames: Float32Array[], energy: number): ClipVisionIndex {
  const embeddings = new Float32Array(frames.length * DIM)
  frames.forEach((f, i) => embeddings.set(f, i * DIM))
  return {
    version: 1,
    mediaId: id,
    duration: frames.length,
    model: 'clipB32',
    dim: DIM,
    times: frames.map((_, i) => i),
    embeddings,
    hubness: frames.map(() => 0),
    motion: {
      fps: 4,
      energy: [energy],
      camera: [0],
      cuts: [],
      meanEnergy: energy,
      p90Energy: energy,
      meanCamera: 0,
    },
  }
}

function project(): Pick<Project, 'analysis'> {
  const size = { width: 1920, height: 1080 }
  const rain = buildVisualAnalysis({
    assetId: 'rain',
    duration: 3,
    sourceSize: size,
    index: clip('rain', [basis(2), basis(2), basis(5)], 1),
  })
  const dance = buildVisualAnalysis({
    assetId: 'dance',
    duration: 3,
    sourceSize: size,
    index: clip('dance', [basis(6), basis(3), basis(3)], 15),
  })
  const city = buildVisualAnalysis({
    assetId: 'city',
    duration: 3,
    sourceSize: size,
    index: clip('city', [basis(4), basis(4), basis(4)], 4),
  })
  return { analysis: { audio: {}, visual: { rain, dance, city } } }
}

function director() {
  const onnx = fakeOnnx({ dim: DIM, textVector: (t) => textVector(t) ?? basis(7) })
  const matcher = createFootageMatcher({ onnx, model: 'clipB32' })
  return createDirectorFootageMatcher({ matcher, getProject: project })
}

describe('director footage matcher', () => {
  it('ranks assets for a lyric line with 0..1 scores and the best start time', async () => {
    const ranked = await director().rank('dancing in the rain tonight')
    expect(ranked.map((r) => r.assetId)).toHaveLength(3)
    const top = await director().rank('rain on the window', { limit: 1 })
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ assetId: 'rain' })
    expect(top[0]!.score).toBeGreaterThan(0.5)
    expect(top[0]!.score).toBeLessThan(1)
    expect(top[0]!.time).toBeLessThan(2)
  })

  it('restricts ranking to the given assets', async () => {
    const ranked = await director().rank('rain', { assetIds: ['dance', 'city'] })
    expect(ranked.map((r) => r.assetId).sort()).toEqual(['city', 'dance'])
  })

  it('describes assets with standout labels and motion', async () => {
    const info = await director().info()
    const byId = Object.fromEntries(info.map((i) => [i.assetId, i]))
    expect(byId.rain!.labels).toContain('rain')
    expect(byId.dance!.labels).toContain('dancing')
    expect(byId.city!.labels).toContain('city')
    expect(byId.dance!.motion!).toBeGreaterThan(byId.city!.motion!)
    expect(byId.city!.motion!).toBeGreaterThan(byId.rain!.motion!)
  })
})
