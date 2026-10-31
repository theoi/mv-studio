import { beforeEach, expect, it, vi } from 'vitest'
import { createProject, type Asset, type AudioAnalysis } from '../../../src/model/index.ts'
import { dispatch, editor } from '../../../src/app/state/project.ts'
import { importFiles } from '../../../src/app/state/importer.ts'

const analyses = vi.hoisted(() => [] as ((analysis: AudioAnalysis) => void)[])

vi.mock('../../../src/app/state/ui.ts', () => ({
  get: () => ({ playhead: 0 }),
  set: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
  editorPreset: vi.fn(),
  maybeStartGuide: vi.fn(),
}))

vi.mock('../../../src/media/mediaStore.ts', () => ({
  mediaStore: {
    requestPersistence: async () => true,
    getFile: async () => new Blob(),
    importFile: async (file: File): Promise<Asset> => ({
      id: 'a-song',
      kind: 'audio',
      name: file.name,
      mimeType: file.type,
      byteSize: file.size,
      storageKey: 'media/a-song',
      duration: 8,
      origin: { type: 'import' },
      createdAt: new Date(0).toISOString(),
    }),
  },
}))

vi.mock('../../../src/analysis/client.ts', () => ({
  decodeAudioFile: async () => ({}),
  setAnalysisCommand: (analysis: AudioAnalysis) => ({ type: 'analysis.setAudio', analysis }),
  SongAnalysisService: class {
    analyze() {
      return { promise: new Promise<AudioAnalysis>((resolve) => analyses.push(resolve)) }
    }
  },
}))

beforeEach(() => {
  analyses.length = 0
  editor.load(createProject({ name: 'Untitled video' }))
})

it('writes the song analysis without an undo step, keeping edits made while it ran undoable and redoable', async () => {
  await importFiles([new File(['x'], 'song.mp3', { type: 'audio/mpeg' })])
  expect(editor.getProject().songAssetId).toBe('a-song')

  dispatch({ type: 'project.rename', name: 'Mine' }, { label: 'Rename' })
  editor.undo()
  await vi.waitFor(() => expect(analyses).toHaveLength(1))
  analyses[0]?.({ assetId: 'a-song', version: 'test', tempo: { bpm: 120, confidence: 1 } })

  await vi.waitFor(() => expect(editor.getProject().analysis.audio['a-song']?.tempo?.bpm).toBe(120))
  expect(editor.undoLabel()).toBe('Import song.mp3')
  expect(editor.redoLabel()).toBe('Rename')
})
