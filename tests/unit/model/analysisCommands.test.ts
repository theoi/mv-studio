import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EditError,
  ProjectEditor,
  createProject,
  newId,
  type Asset,
  type AudioAnalysis,
  type AudioFeatures,
} from '../../../src/model/index.ts'

function songAsset(): Asset {
  return {
    id: newId(),
    kind: 'audio',
    name: 'song.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 1000,
    storageKey: 'media/song.mp3',
    duration: 20,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
}

const features = (v: number): AudioFeatures => ({
  rate: 50,
  loudness: [v],
  bands: [[v]],
  bandEdgesHz: [20, 20000],
  onsets: [],
})

function setup() {
  const editor = new ProjectEditor(createProject())
  const song = songAsset()
  editor.dispatch({ type: 'asset.add', asset: song })
  const detected: AudioAnalysis = {
    assetId: song.id,
    version: 'v1',
    tempo: { bpm: 120, confidence: 0.8 },
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0],
    sections: [
      { id: 's1', start: 0, end: 10, label: 'verse' },
      { id: 's2', start: 10, end: 20, label: 'chorus' },
    ],
  }
  editor.dispatch({ type: 'analysis.setDetected', analysis: detected }, { history: 'skip' })
  const analysis = () => editor.getProject().analysis.audio[song.id]
  return { editor, song, detected, analysis }
}

describe('narrow analysis commands', () => {
  it('keeps a section rename made while stems were separating, and the rename still undoes', () => {
    const { editor, song, analysis } = setup()
    editor.dispatch({
      type: 'analysis.updateSection',
      assetId: song.id,
      sectionId: 's2',
      patch: { label: 'Hook' },
    })
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: song.id,
        stems: { vocals: 'v1' },
        stemFeatures: { vocals: features(0.5) },
      },
      { history: 'skip' },
    )
    expect(analysis()?.sections?.[1]?.label).toBe('Hook')
    expect(analysis()?.stems).toEqual({ vocals: 'v1' })

    expect(editor.undoLabel()).toBe('Edit section')
    editor.undo()
    expect(analysis()?.sections?.[1]?.label).toBe('chorus')
    expect(analysis()?.stems).toEqual({ vocals: 'v1' })
    expect(analysis()?.stemFeatures?.vocals?.loudness).toEqual([0.5])
    editor.redo()
    expect(analysis()?.sections?.[1]?.label).toBe('Hook')
    expect(analysis()?.stems).toEqual({ vocals: 'v1' })
  })

  it('undoes a grid correction without dropping stems that arrived after it', () => {
    const { editor, song, analysis } = setup()
    editor.dispatch({
      type: 'analysis.setGrid',
      assetId: song.id,
      grid: { tempo: { bpm: 60, confidence: 0.8 }, beats: [0, 1] },
    })
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: song.id,
        stems: { drums: 'd1' },
        stemFeatures: { drums: features(1) },
      },
      { history: 'skip' },
    )
    expect(analysis()?.tempo?.bpm).toBe(60)
    expect(analysis()?.downbeats).toEqual([0])
    editor.undo()
    expect(analysis()?.tempo?.bpm).toBe(120)
    expect(analysis()?.beats).toEqual([0, 0.5, 1, 1.5])
    expect(analysis()?.stems).toEqual({ drums: 'd1' })
  })

  it('applies a refinement only to the parts the user has not corrected', () => {
    const { editor, song, detected, analysis } = setup()
    const baseline = {
      tempo: detected.tempo,
      beats: detected.beats,
      downbeats: detected.downbeats,
      sections: detected.sections,
    }
    const refined = {
      tempo: { bpm: 121, confidence: 0.95 },
      beats: [0.01, 0.5, 1, 1.5],
      downbeats: [0.01],
      sections: [
        { id: 'r1', start: 0, end: 9.9, label: 'verse' },
        { id: 'r2', start: 9.9, end: 20, label: 'chorus' },
      ],
    }

    editor.dispatch({
      type: 'analysis.updateSection',
      assetId: song.id,
      sectionId: 's1',
      patch: { label: 'Intro' },
    })
    editor.dispatch({ type: 'analysis.setRefined', assetId: song.id, refined, baseline }, { history: 'skip' })
    expect(analysis()?.tempo).toEqual(refined.tempo)
    expect(analysis()?.downbeats).toEqual([0.01])
    expect(analysis()?.sections?.map((s) => s.label)).toEqual(['Intro', 'chorus'])
    editor.undo()
    expect(analysis()?.sections?.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(analysis()?.tempo).toEqual(refined.tempo)

    const grid = setup()
    grid.editor.dispatch({ type: 'analysis.setGrid', assetId: grid.song.id, grid: { downbeats: [0.5] } })
    grid.editor.dispatch(
      { type: 'analysis.setRefined', assetId: grid.song.id, refined, baseline },
      { history: 'skip' },
    )
    expect(grid.analysis()?.downbeats).toEqual([0.5])
    expect(grid.analysis()?.tempo).toEqual(detected.tempo)
    expect(grid.analysis()?.sections?.map((s) => s.id)).toEqual(['r1', 'r2'])
  })

  it('keeps attached stems when the song is analyzed again', () => {
    const { editor, song, detected, analysis } = setup()
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: song.id,
        stems: { bass: 'b1' },
        stemFeatures: { bass: features(0.2) },
      },
      { history: 'skip' },
    )
    editor.dispatch(
      { type: 'analysis.setDetected', analysis: { ...detected, version: 'v2', beats: [0.1] } },
      { history: 'skip' },
    )
    expect(analysis()?.version).toBe('v2')
    expect(analysis()?.beats).toEqual([0.1])
    expect(analysis()?.stems).toEqual({ bass: 'b1' })
    expect(analysis()?.stemFeatures?.bass?.loudness).toEqual([0.2])
  })

  describe('in development', () => {
    afterEach(() => vi.restoreAllMocks())

    it('warns when a derived write overlaps an undoable edit, and only then', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { editor, song, detected } = setup()
      editor.dispatch({
        type: 'analysis.updateSection',
        assetId: song.id,
        sectionId: 's2',
        patch: { label: 'Hook' },
      })
      editor.dispatch(
        { type: 'analysis.setStems', assetId: song.id, stems: { vocals: 'v1' }, stemFeatures: {} },
        { history: 'skip' },
      )
      expect(warn).not.toHaveBeenCalled()
      editor.dispatch({ type: 'analysis.setDetected', analysis: detected }, { history: 'skip' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('Edit section')
    })
  })

  it('refuses a grid correction for a song without analysis', () => {
    const editor = new ProjectEditor(createProject())
    expect(() =>
      editor.dispatch({ type: 'analysis.setGrid', assetId: 'missing', grid: { beats: [0] } }),
    ).toThrow(EditError)
  })
})
