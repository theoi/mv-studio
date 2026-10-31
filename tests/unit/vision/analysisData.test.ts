import { describe, expect, it } from 'vitest'
import {
  buildVisualAnalysis,
  projectLibrary,
  readClipIndex,
  readSubjectTrack,
  VISION_ANALYSIS_VERSION,
} from '../../../src/vision/analysisData.ts'
import type { ClipVisionIndex, SubjectTrack } from '../../../src/vision/types.ts'
import { createRng, randomUnit } from './matching/helpers.ts'

function index(mediaId: string, frames = 30, dim = 512): ClipVisionIndex {
  const rng = createRng(7)
  const embeddings = new Float32Array(frames * dim)
  for (let i = 0; i < frames; i++) embeddings.set(randomUnit(dim, rng), i * dim)
  return {
    version: 1,
    mediaId,
    duration: frames,
    model: 'clipB32',
    dim,
    times: Array.from({ length: frames }, (_, i) => i),
    embeddings,
    hubness: Array.from({ length: frames }, (_, i) => 0.2 + i / 1000),
    motion: {
      fps: 4,
      energy: [1.234, 5.678],
      camera: [0.5, 0.25],
      cuts: [3.5],
      meanEnergy: 3.456,
      p90Energy: 5.2,
      meanCamera: 0.375,
    },
  }
}

const SUBJECTS: SubjectTrack = {
  version: 1,
  mediaId: 'a1',
  sourceSize: { width: 1920, height: 1080 },
  samples: [
    {
      t: 0,
      focus: { x: 0.5, y: 0.3 },
      box: { x: 0.4, y: 0.2, width: 0.2, height: 0.7 },
      confidence: 0.9,
      source: 'face',
    },
    { t: 0.2, focus: { x: 0.5, y: 0.5 }, box: null, confidence: 0, source: 'none' },
  ],
}

describe('visual analysis data', () => {
  it('stores embeddings compactly and reads them back with near-identical similarities', () => {
    const original = index('a1')
    const analysis = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: original,
    })
    expect(analysis.version).toBe(VISION_ANALYSIS_VERSION)
    expect(JSON.stringify(analysis).length).toBeLessThan(original.embeddings.byteLength / 2.5)
    const back = readClipIndex(JSON.parse(JSON.stringify(analysis)))!
    expect(back.times).toEqual(original.times)
    expect(back.motion.cuts).toEqual([3.5])
    expect(back.motion.energy).toEqual([1.23, 5.68])
    for (let i = 0; i < original.times.length; i++) {
      let dot = 0
      for (let k = 0; k < original.dim; k++)
        dot += back.embeddings[i * 512 + k]! * original.embeddings[i * 512 + k]!
      expect(dot).toBeGreaterThan(0.999)
    }
  })

  it('merges new parts into the previous analysis', () => {
    const first = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a1'),
    })
    const second = buildVisualAnalysis(
      { assetId: 'a1', duration: 30, sourceSize: { width: 1920, height: 1080 }, subjects: SUBJECTS },
      first,
    )
    expect(readClipIndex(second)).not.toBeNull()
    expect(readSubjectTrack(second)?.samples).toEqual(SUBJECTS.samples)
  })

  it('returns null for missing, foreign or corrupt data', () => {
    const good = buildVisualAnalysis({
      assetId: 'a1',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a1'),
    })
    expect(readClipIndex(undefined)).toBeNull()
    expect(readClipIndex({ ...good, version: 'other-1' })).toBeNull()
    const truncated = structuredClone(good)
    const emb = truncated.data.embedding as { data: string }
    emb.data = emb.data.slice(0, 100)
    expect(readClipIndex(truncated)).toBeNull()
    expect(readSubjectTrack(good)).toBeNull()
  })

  it('collects the matching library from a project, skipping assets without an index', () => {
    const a = buildVisualAnalysis({
      assetId: 'a',
      duration: 30,
      sourceSize: { width: 1920, height: 1080 },
      index: index('a'),
    })
    const b = buildVisualAnalysis({
      assetId: 'b',
      duration: 5,
      sourceSize: { width: 1920, height: 1080 },
      subjects: SUBJECTS,
    })
    const library = projectLibrary({ analysis: { audio: {}, visual: { a, b } } })
    expect(library.map((l) => l.mediaId)).toEqual(['a'])
  })
})
