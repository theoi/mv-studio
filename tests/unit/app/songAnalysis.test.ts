import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefinedFields } from '../../../src/analysis/song.ts'
import {
  createAudioClip,
  createProject,
  createTrack,
  type Asset,
  type AudioAnalysis,
  type Project,
} from '../../../src/model/index.ts'
import { JobError, jobs, type JobContext } from '../../../src/shared/jobs.ts'
import { editor } from '../../../src/app/state/project.ts'
import {
  barsState,
  ensureBars,
  findBars,
  findBarsInBackground,
  setSongAnalysisServiceForTests,
} from '../../../src/app/state/songAnalysis.ts'
import { toast } from '../../../src/app/state/ui.ts'

vi.mock('../../../src/app/state/ui.ts', () => ({
  get: () => ({ playhead: 0 }),
  set: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
  editorPreset: vi.fn(),
  maybeStartGuide: vi.fn(),
}))

/** Refinement runs on the real job runner and ends when the test says, like the worker would. */
const runs: { ctx: JobContext; resolve: (f: RefinedFields) => void; reject: (e: Error) => void }[] = []

beforeEach(() => {
  runs.length = 0
  vi.mocked(toast).mockClear()
  setSongAnalysisServiceForTests({
    refine: () =>
      jobs.run({
        kind: 'analysis.downbeats',
        title: 'Finding bars and refining beats',
        run: (ctx) =>
          new Promise<RefinedFields>((resolve, reject) => {
            runs.push({ ctx, resolve, reject })
            ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled')))
          }),
      }),
    release: async () => undefined,
  })
})

const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
const bars = beats.filter((_, i) => i % 4 === 0)

let songs = 0
/** A project whose song (a fresh asset id each time) plays from 2 s on the timeline, from 1 s into the file. */
function project(analysis: Partial<AudioAnalysis>): Project {
  const p = createProject()
  const id = `song-${++songs}`
  const song: Asset = {
    id,
    kind: 'audio',
    name: 'song.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 1,
    storageKey: `media/${id}`,
    duration: 10,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
  const track = createTrack('audio', 'Song')
  const clip = createAudioClip({ trackId: track.id, assetId: id, start: 2, duration: 9, sourceStart: 1 })
  p.assets[id] = song
  p.tracks.push(track)
  p.clips[clip.id] = clip
  p.songAssetId = id
  p.analysis.audio[id] = {
    assetId: id,
    version: 'test',
    tempo: { bpm: 120, confidence: 0.6 },
    beats,
    ...analysis,
  }
  return p
}

const songId = () => editor.getProject().songAssetId as string
const stored = () => editor.getProject().analysis.audio[songId()]
const refined = (): RefinedFields => ({ tempo: { bpm: 120, confidence: 0.95 }, beats, downbeats: bars })

describe('bars state', () => {
  it('is ready only with found bars, given in timeline time', () => {
    expect(barsState(createProject())).toEqual({ status: 'none' })
    expect(barsState(project({}))).toEqual({ status: 'unavailable' })
    // The song plays from 1 s into the file at 2 s on the timeline, for 9 s: a bar at 10.5 s in the file is cut off.
    expect(barsState(project({ downbeats: [1, 3, 10.5] }))).toEqual({ status: 'ready', downbeats: [2, 4] })
  })

  it('is finding while the refinement step runs, then ready, without an undo step', async () => {
    editor.load(project({}))
    const found = findBars(songId())
    expect(barsState()).toEqual({ status: 'finding' })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0]?.resolve(refined())
    expect(await found).toBe(true)
    expect(stored()?.downbeats).toEqual(bars)
    expect(barsState().status).toBe('ready')
    expect(editor.canUndo()).toBe(false)
  })

  it('is unavailable when finding fails, says so once, and is not retried in the background', async () => {
    editor.load(project({}))
    const stop = findBarsInBackground()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0]?.reject(new JobError('network', 'The model could not be downloaded.'))
    await vi.waitFor(() => expect(barsState()).toEqual({ status: 'unavailable' }))
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Could not find the bars/))
    editor.load(editor.getProject())
    await Promise.resolve()
    expect(runs).toHaveLength(1)
    stop()
  })
})

describe('ensureBars', () => {
  it('resolves at once when bars are found and without beats', async () => {
    editor.load(project({ downbeats: bars }))
    expect(await ensureBars()).toBe(true)
    editor.load(createProject())
    expect(await ensureBars()).toBe(false)
    expect(runs).toHaveLength(0)
  })

  it('follows a refinement already running and reports its progress', async () => {
    editor.load(project({}))
    void findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const progress: number[] = []
    const waiting = ensureBars({ progress: (f) => progress.push(f) })
    runs[0]?.ctx.progress({ fraction: 0.4 })
    await vi.waitFor(() => expect(progress).toContain(0.4))
    runs[0]?.resolve(refined())
    expect(await waiting).toBe(true)
    expect(runs).toHaveLength(1)
  })

  it('starts the refinement when none runs, and cancelling the waiting job cancels it', async () => {
    editor.load(project({}))
    const controller = new AbortController()
    const waiting = ensureBars({ signal: controller.signal })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(runs[0]?.ctx.signal.aborted).toBe(true))
    expect(stored()?.downbeats).toBeUndefined()
  })

  it('keeps the beats the user set while it ran and puts the bars on them', async () => {
    editor.load(project({}))
    const found = findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const halved = beats.filter((_, i) => i % 2 === 0)
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: songId(),
        grid: { tempo: { bpm: 60, confidence: 1 }, beats: halved, downbeats: undefined },
      },
      { label: 'Set tempo' },
    )
    runs[0]?.resolve(refined())
    expect(await found).toBe(true)
    expect(stored()?.beats).toEqual(halved)
    expect(stored()?.downbeats).toEqual(bars)
    expect(editor.undoLabel()).toBe('Set tempo')
  })
})
