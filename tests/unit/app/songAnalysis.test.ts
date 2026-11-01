import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefinedFields } from '../../../src/analysis/song.ts'
import { lyricChorusCommand } from '../../../src/analysis/structure/chorus.ts'
import {
  createAudioClip,
  createProject,
  createTrack,
  type Asset,
  type AudioAnalysis,
  type LyricLine,
  type LyricsDoc,
  type Project,
  type SectionEdit,
  type SongSection,
} from '../../../src/model/index.ts'
import { JobError, jobs, type JobContext } from '../../../src/shared/jobs.ts'
import { editor } from '../../../src/app/state/project.ts'
import {
  analyzeAgain,
  barPosition,
  barsState,
  ensureBars,
  findBars,
  findBarsInBackground,
  setSongAnalysisServiceForTests,
  setTempoLevel,
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
    // One bar start alone gives no bar length.
    expect(barsState(project({ downbeats: [1] }))).toEqual({ status: 'unavailable' })
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
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/^Bars not found yet\. The model could not be downloaded\. Analyze again/),
    )
    editor.load(editor.getProject())
    await Promise.resolve()
    expect(runs).toHaveLength(1)
    stop()
  })
})

describe('Half and Double', () => {
  const found = { tempo: { bpm: 120, confidence: 0.95 }, downbeats: bars }

  it('brings back the bars found before when Half follows Double', () => {
    editor.load(project(found))
    setTempoLevel(2)
    expect(stored()?.downbeats).toHaveLength(bars.length * 2)
    setTempoLevel(0.5)
    expect(stored()?.beats).toEqual(beats)
    expect(stored()?.downbeats).toEqual(bars)
    expect(stored()?.tempo).toEqual(found.tempo)
    expect(editor.undoLabel()).toBe('Half tempo')
    expect(toast).toHaveBeenLastCalledWith('Tempo set to 120 BPM', expect.objectContaining({ label: 'Undo' }))
  })

  it('says so when Half leaves no bars, also after Double once the bars were moved', () => {
    editor.load(project(found))
    setTempoLevel(0.5)
    expect(stored()?.downbeats).toBeUndefined()
    expect(toast).toHaveBeenLastCalledWith(
      'Tempo set to 60 BPM. Bars cleared: use Set first beat to start them again.',
      expect.objectContaining({ label: 'Undo' }),
    )
    editor.load(project(found))
    setTempoLevel(2)
    const doubled = stored()!
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: songId(),
        grid: { tempo: doubled.tempo, beats: doubled.beats, downbeats: doubled.downbeats?.slice(1) },
      },
      { label: 'Set first beat' },
    )
    setTempoLevel(0.5)
    expect(stored()?.downbeats).toBeUndefined()
    expect(toast).toHaveBeenLastCalledWith(
      'Tempo set to 120 BPM. Bars cleared: use Set first beat to start them again.',
      expect.anything(),
    )
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

  it('follows a refinement already running and reports its progress and the time it still needs', async () => {
    editor.load(project({}))
    void findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const progress: [number, number | undefined][] = []
    const waiting = ensureBars({ progress: (f, eta) => progress.push([f, eta]) })
    runs[0]?.ctx.progress({ fraction: 0.4 })
    await vi.waitFor(() => expect(progress).toContainEqual([0.4, undefined]))
    runs[0]?.ctx.progress({ fraction: 0.7, etaSeconds: 12 })
    await vi.waitFor(() => expect(progress).toContainEqual([0.7, 12]))
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

  it('keeps the beats the user set while it ran and puts bars of four on them', async () => {
    editor.load(project({}))
    const found = findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const doubled = beats.flatMap((t, i) => (i + 1 < beats.length ? [t, t + 0.25] : [t]))
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: songId(),
        grid: { tempo: { bpm: 240, confidence: 1 }, beats: doubled, downbeats: undefined },
      },
      { label: 'Set tempo' },
    )
    runs[0]?.resolve(refined())
    expect(await found).toBe(true)
    expect(stored()?.beats).toEqual(doubled)
    // The bars found span eight of the doubled beats: a bar starts every four.
    expect(stored()?.downbeats).toEqual(beats.filter((_, i) => i % 2 === 0))
    expect(editor.undoLabel()).toBe('Set tempo')
  })
})

describe('barPosition', () => {
  it('counts bars from the first bar found and beats from its downbeat, and nothing before it', () => {
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
    const downbeats = [0.5, 2.5]
    expect(barPosition(downbeats, grid, 0.2)).toBeNull()
    expect(barPosition(downbeats, grid, 0.5)).toEqual({ bar: 1, beat: 1 })
    expect(barPosition(downbeats, grid, 1.7)).toEqual({ bar: 1, beat: 3 })
    expect(barPosition(downbeats, grid, 3.9)).toEqual({ bar: 2, beat: 3 })
  })
})

const section = (
  id: string,
  start: number,
  end: number,
  label: string,
  confidence?: number,
): SongSection => ({
  id,
  start,
  end,
  label,
  repeatGroup: 0,
  energy: 0.5,
  ...(confidence ? { confidence } : {}),
})

/** Words one after another from `start`, `step` seconds each. */
const words = (text: string, start: number, step: number) =>
  text.split(' ').map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step }))
const line = (id: string, text: string, start: number, step: number): LyricLine => {
  const ws = words(text, start, step)
  return { id, text, start: ws[0]!.start, end: ws.at(-1)!.end, words: ws }
}
/** A chorus sung at 0.6-2.4 s and 4.6-6.4 s, each followed by verse words. */
const LYRICS: LyricsDoc = {
  source: 'pasted',
  lines: [
    line('c1', 'we sing all', 0.6, 0.3),
    line('c2', 'night long tonight', 1.5, 0.3),
    line('v1', 'woke up late on sunday morning', 2.6, 0.2),
    line('c3', 'we sing all', 4.6, 0.3),
    line('c4', 'night long tonight', 5.5, 0.3),
    line('v2', 'streets are empty shops are closed', 6.6, 0.2),
  ],
}
const choruses = () =>
  stored()
    ?.sections?.filter((s) => s.label === 'chorus')
    .map((s) => [s.start, s.end])

describe('the lyrics’ chorus once bars are found', () => {
  it('is found again on the refined sections and put on the bars, when it was set on beats meanwhile', async () => {
    const p = project({ sections: [section('a', 0, 4, 'verse'), section('b', 4, 8, 'verse')] })
    p.lyrics = LYRICS
    editor.load(p)
    const found = findBars(songId(), { sections: true })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    editor.dispatch(lyricChorusCommand(stored()!, LYRICS)!, { history: 'skip' })
    expect(
      choruses()
        ?.flat()
        .every((t) => bars.includes(t)),
    ).toBe(false)
    runs[0]?.resolve({ ...refined(), sections: [section('r1', 0, 4, 'verse'), section('r2', 4, 8, 'verse')] })
    expect(await found).toBe(true)
    expect(choruses()).toEqual([
      [0, 2],
      [4, 6],
    ])
    expect(stored()?.sections?.[0]?.id).toBe('r1')
  })

  it.each([
    ['renamed', { label: 'bridge' }, 'bridge'],
    ['picked a color for', { color: 'bridge' }, 'verse'],
  ])(
    'keeps the sections and ids when the user %s a section while the bars were being found',
    async (_, patch, label) => {
      const p = project({ sections: [section('a', 0, 4, 'verse'), section('b', 4, 8, 'verse')] })
      p.lyrics = LYRICS
      editor.load(p)
      const found = findBars(songId(), { sections: true })
      await vi.waitFor(() => expect(runs).toHaveLength(1))
      editor.dispatch({ type: 'analysis.updateSection', assetId: songId(), sectionId: 'b', patch })
      runs[0]?.resolve({
        ...refined(),
        sections: [section('r1', 0, 4, 'verse'), section('r2', 4, 8, 'chorus')],
      })
      expect(await found).toBe(true)
      expect(stored()?.downbeats).toEqual(bars)
      expect(stored()?.sections?.map((s) => [s.id, s.label, s.start, s.end])).toEqual([
        ['a', 'verse', 0, 4],
        ['b', label, 4, 8],
      ])
    },
  )

  it('moves its edges onto the bars found later, keeping the sections', async () => {
    const p = project({
      sections: [
        section('a', 0, 2.5, 'chorus', 0.8),
        section('b', 2.5, 4, 'verse'),
        section('c', 4, 6.5, 'chorus', 0.8),
        section('d', 6.5, 8, 'verse'),
      ],
    })
    p.lyrics = LYRICS
    editor.load(p)
    const found = findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0]?.resolve(refined())
    expect(await found).toBe(true)
    expect(stored()?.sections?.map((s) => [s.id, s.start, s.end])).toEqual([
      ['a', 0, 2],
      ['b', 2, 4],
      ['c', 4, 6],
      ['d', 6, 8],
    ])
  })

  it.each([
    ['dragged', { edited: ['start'] as SectionEdit[] }],
    ['named', { label: 'Breakdown', confidence: 1 }],
  ])('leaves the edges of a section the user %s where they are', async (_, user) => {
    const p = project({
      sections: [
        section('a', 0, 2.5, 'chorus', 0.8),
        { ...section('b', 2.5, 4.5, 'verse'), ...user },
        section('c', 4.5, 6.5, 'chorus', 0.8),
        section('d', 6.5, 8, 'verse'),
      ],
    })
    p.lyrics = LYRICS
    editor.load(p)
    const found = findBars(songId())
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0]?.resolve(refined())
    expect(await found).toBe(true)
    // Only the chorus edge between two detected sections moves onto the bar.
    expect(stored()?.sections?.map((s) => [s.id, s.start, s.end])).toEqual([
      ['a', 0, 2.5],
      ['b', 2.5, 4.5],
      ['c', 4.5, 6],
      ['d', 6, 8],
    ])
  })
})

describe('Analyze again', () => {
  it('keeps the sections the user named, as one undo step', async () => {
    const named = { id: 'mine', start: 2, end: 6, label: 'Hook', repeatGroup: 5, confidence: 1 }
    editor.load(
      project({
        sections: [{ id: 'old', start: 0, end: 2, label: 'intro', confidence: 0.4 }, named],
      }),
    )
    const before = stored()?.sections
    const fresh: AudioAnalysis = {
      assetId: songId(),
      version: 'test',
      tempo: { bpm: 100, confidence: 0.9 },
      beats,
      sections: [
        { id: 'n1', start: 0, end: 4, label: 'verse', repeatGroup: 0 },
        { id: 'n2', start: 4, end: 10, label: 'chorus', repeatGroup: 1, confidence: 0.4 },
      ],
    }
    setSongAnalysisServiceForTests({
      analyzeAgain: () =>
        jobs.run({ kind: 'analysis.song', title: 'Analyzing the song', run: async () => fresh }),
    })
    await analyzeAgain()
    expect(stored()?.tempo?.bpm).toBe(100)
    expect(stored()?.sections?.map((s) => [s.label, s.start, s.end])).toEqual([
      ['verse', 0, 2],
      ['Hook', 2, 6],
      ['chorus', 6, 10],
    ])
    expect(toast).toHaveBeenCalledWith(
      'Found 100 BPM and 3 sections. Kept 1 section you named.',
      expect.objectContaining({ label: 'Undo' }),
    )
    editor.undo()
    expect(stored()?.sections).toEqual(before)
  })
  it('keeps a section whose edges the user dragged, and says the kept section was edited', async () => {
    const dragged = { ...section('mine', 2, 6, 'verse', 0.4), edited: ['start', 'end'] as SectionEdit[] }
    editor.load(project({ sections: [section('old', 0, 2, 'intro', 0.4), dragged] }))
    const fresh: AudioAnalysis = {
      assetId: songId(),
      version: 'test',
      tempo: { bpm: 100, confidence: 0.9 },
      beats,
      sections: [section('n1', 0, 4, 'verse'), section('n2', 4, 10, 'chorus', 0.4)],
    }
    setSongAnalysisServiceForTests({
      analyzeAgain: () =>
        jobs.run({ kind: 'analysis.song', title: 'Analyzing the song', run: async () => fresh }),
    })
    await analyzeAgain()
    expect(stored()?.sections?.map((s) => [s.id, s.start, s.end])).toEqual([
      ['n1', 0, 2],
      ['mine', 2, 6],
      ['n2', 6, 10],
    ])
    expect(toast).toHaveBeenCalledWith(
      'Found 100 BPM and 3 sections. Kept 1 section you edited.',
      expect.objectContaining({ label: 'Undo' }),
    )
  })
  it('keeps named sections, ids unique, when the pasted lyrics put a chorus edge inside one', async () => {
    // "bridge" was picked from the menu (confidence 1); "Hook" was typed in a project from before confidences.
    const picked = { id: 'mine', start: 2, end: 5, label: 'bridge', confidence: 1 }
    const typed = { id: 'typed', start: 7, end: 9, label: 'Hook' }
    const p = project({
      sections: [{ id: 'old', start: 0, end: 2, label: 'intro', confidence: 0.4 }, picked, typed],
    })
    p.lyrics = LYRICS
    editor.load(p)
    const fresh: AudioAnalysis = {
      assetId: songId(),
      version: 'test',
      tempo: { bpm: 120, confidence: 0.9 },
      beats,
      sections: [
        { id: 'n1', start: 0, end: 4, label: 'verse', repeatGroup: 0 },
        { id: 'n2', start: 4, end: 10, label: 'chorus', repeatGroup: 1, confidence: 0.4 },
      ],
    }
    setSongAnalysisServiceForTests({
      analyzeAgain: () =>
        jobs.run({ kind: 'analysis.song', title: 'Analyzing the song', run: async () => fresh }),
    })
    await analyzeAgain()
    const sections = stored()?.sections ?? []
    // The lyrics' second chorus starts at 4.6 s, inside "bridge": the chorus starts after it instead.
    expect(sections.map((s) => [s.label, s.start, s.end])).toEqual([
      ['chorus', 0, 2],
      ['bridge', 2, 5],
      ['chorus', 5, 7],
      ['Hook', 7, 9],
      ['verse', 9, 10],
    ])
    expect(sections.find((s) => s.id === 'mine')).toEqual({ ...picked, repeatGroup: 0 })
    expect(sections.find((s) => s.id === 'typed')).toEqual({ ...typed, repeatGroup: 1 })
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length)
    expect(toast).toHaveBeenCalledWith(
      'Found 120 BPM and 5 sections. Kept 2 sections you named.',
      expect.objectContaining({ label: 'Undo' }),
    )
  })
})
