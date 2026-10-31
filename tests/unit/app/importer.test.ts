import { beforeEach, expect, it, vi } from 'vitest'
import type * as AnalysisClient from '../../../src/analysis/client.ts'
import type { RefinedFields } from '../../../src/analysis/song.ts'
import {
  createProject,
  createVideoClip,
  type Asset,
  type AudioAnalysis,
  type EditCommand,
} from '../../../src/model/index.ts'
import { dispatch, editor } from '../../../src/app/state/project.ts'
import { assetPlacement, importFiles } from '../../../src/app/state/importer.ts'
import { findBars } from '../../../src/app/state/songAnalysis.ts'

const analyses = vi.hoisted(() => [] as ((analysis: AudioAnalysis) => void)[])
const refinements = vi.hoisted(() => [] as ((fields: RefinedFields) => void)[])

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

vi.mock('../../../src/analysis/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof AnalysisClient>()),
  decodeAudioFile: async () => ({}),
  SongAnalysisService: class {
    analyze() {
      return { promise: new Promise<AudioAnalysis>((resolve) => analyses.push(resolve)) }
    }
    refine() {
      return { promise: new Promise<RefinedFields>((resolve) => refinements.push(resolve)) }
    }
    async release() {}
  },
}))

beforeEach(() => {
  analyses.length = 0
  refinements.length = 0
  editor.load(createProject({ name: 'Untitled video' }))
})

const beats = (n: number, step: number) => Array.from({ length: n }, (_, i) => i * step)

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
  // Finishes finding bars, which started after the analysis, so the next test imports the song afresh.
  await vi.waitFor(() => expect(refinements).toHaveLength(1))
  refinements[0]?.({})
  expect(await findBars('a-song')).toBe(false)
})

it('refines beats and bars in the background after the fast analysis, without an undo step', async () => {
  await importFiles([new File(['x'], 'song.mp3', { type: 'audio/mpeg' })])
  await vi.waitFor(() => expect(analyses).toHaveLength(1))
  analyses[0]?.({
    assetId: 'a-song',
    version: 'test',
    tempo: { bpm: 120, confidence: 0.6 },
    beats: beats(16, 0.5),
  })

  await vi.waitFor(() => expect(refinements).toHaveLength(1))
  refinements[0]?.({ tempo: { bpm: 121, confidence: 0.9 }, beats: beats(16, 0.496), downbeats: [0, 1.984] })

  await vi.waitFor(() => expect(editor.getProject().analysis.audio['a-song']?.downbeats).toEqual([0, 1.984]))
  expect(editor.getProject().analysis.audio['a-song']?.tempo?.bpm).toBe(121)
  expect(editor.undoLabel()).toBe('Import song.mp3')
})

it('puts a clip on a new numbered track when every footage track is taken at the playhead', () => {
  const clip: Asset = {
    id: 'v',
    kind: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 1,
    storageKey: 'media/v',
    duration: 4,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
  const placedOn = (names: string[]) => {
    const p = createProject({ name: 'p' })
    const visual = p.tracks.find((t) => t.kind === 'visual')!
    const tracks = names.map((name, i) => ({ ...visual, id: `t${i}`, name }))
    p.tracks = [...tracks, ...p.tracks.filter((t) => t.kind !== 'visual')]
    p.assets = { v: clip }
    for (const t of tracks) {
      const taken = createVideoClip({ trackId: t.id, assetId: 'v', start: 0, duration: 4 })
      p.clips[taken.id] = taken
    }
    const add = assetPlacement(p, clip, { start: 1 })?.commands.find(
      (c): c is Extract<EditCommand, { type: 'track.add' }> => c.type === 'track.add',
    )
    return add?.track.name
  }
  expect(placedOn(['Video'])).toBe('Video 2')
  expect(placedOn(['Video 1'])).toBe('Video 2')
  expect(placedOn(['Video', 'Video 2'])).toBe('Video 3')
  expect(placedOn(['Footage'])).toBe('Video')
  expect(placedOn(['Video 2024'])).toBe('Video')
})
