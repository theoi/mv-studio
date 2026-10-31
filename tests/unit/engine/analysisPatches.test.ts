import { describe, expect, it } from 'vitest'
import { analysisPatches, applyAnalysisPatches } from '../../../src/engine/previewWorker.ts'
import type { Project } from '../../../src/model/types.ts'

type Analysis = Project['analysis']

const song = () => ({
  assetId: 'song',
  version: '1',
  tempo: { bpm: 120, confidence: 1 },
  beats: [0, 0.5, 1],
  sections: [{ id: 's1', label: 'verse', start: 0, end: 8 }],
  features: { rate: 10, loudness: [0.1, 0.2, 0.3], bands: [[1], [2], [3]] },
})

const base = (): Analysis =>
  ({
    audio: { song: song() },
    visual: { clip: { assetId: 'clip', version: '1', data: { a: 1 } } },
  }) as unknown as Analysis

describe('analysis patches for the render worker', () => {
  it('sends only the edited field of an asset, not its feature arrays', () => {
    const from = base()
    const to = {
      ...from,
      audio: { song: { ...from.audio.song!, sections: [{ id: 's1', label: 'verse', start: 0, end: 7 }] } },
    }
    expect(analysisPatches(from, to as Analysis)).toEqual([
      { path: ['audio', 'song', 'sections'], value: to.audio.song.sections },
    ])
  })

  it('sends nothing when the analysis is unchanged', () => {
    const a = base()
    expect(analysisPatches(a, a)).toEqual([])
  })

  it('rebuilds the new analysis from the old one, keeping unchanged values as they were', () => {
    const from = base()
    const old = from.audio.song!
    const to = {
      audio: {
        // A changed field, and a field removed.
        song: { ...old, sections: [{ id: 's1', label: 'chorus', start: 0, end: 8 }], tempo: undefined },
        // A new asset.
        stem: { assetId: 'stem', version: '1', beats: [0.25] },
      },
      visual: {},
    } as unknown as Analysis
    delete (to.audio.song as { tempo?: unknown }).tempo
    const patches = analysisPatches(from, to)
    expect(patches).toContainEqual({ path: ['audio', 'song', 'tempo'], remove: true })
    expect(patches).toContainEqual({ path: ['visual', 'clip'], remove: true })
    const next = applyAnalysisPatches(structuredClone(from), patches)
    expect(next).toEqual(to)
    expect('tempo' in next.audio.song!).toBe(false)

    // In the worker the old analysis is its own copy; what the patches did not touch keeps its identity there.
    const copy = structuredClone(from)
    expect(applyAnalysisPatches(copy, patches).audio.song!.features).toBe(copy.audio.song!.features)
  })

  it('takes a whole analysis when there was none before', () => {
    const to = base()
    expect(applyAnalysisPatches(undefined, analysisPatches(undefined as unknown as Analysis, to))).toEqual(to)
  })
})
