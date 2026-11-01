import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefinedFields } from '../../../src/analysis/song.ts'
import { autoCut, autoCutPool } from '../../../src/vision/autocut/index.ts'
import {
  analysisBacklog,
  autoCutAssets,
  autoCutOptions,
  clipChoice,
  DEFAULT_AUTOCUT_CHOICES,
  matchesMood,
  setClipChoice,
  startAutoCut,
  unanalyzedClipCount,
  unanalyzedWarning,
  undoAutoCut,
  type AutoCutChoices,
} from '../../../src/app/state/autocut.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { barsState, setSongAnalysisServiceForTests } from '../../../src/app/state/songAnalysis.ts'
import type * as Footage from '../../../src/app/state/footage.ts'
import { JobError, jobs, type JobErrorCode } from '../../../src/shared/jobs.ts'
import type { IndexingState } from '../../../src/vision/index.ts'

vi.mock('../../../src/app/state/footage.ts', async (original) => ({
  ...(await original<typeof Footage>()),
  visionService: () => Promise.resolve({ matcher: undefined }),
}))

const choices: AutoCutChoices = { ...DEFAULT_AUTOCUT_CHOICES, pace: 'beat', followEnergy: false }

beforeEach(() => loadDemoProject())

it('cuts the selected section, else the section under the playhead', () => {
  const project = editor.getProject()
  const selected = autoCutOptions(
    { ...choices, range: 'section' },
    project,
    { type: 'section', id: 's-c1' },
    10,
  )
  expect(selected.range).toEqual({ start: 64, end: 96 })
  const atPlayhead = autoCutOptions({ ...choices, range: 'section' }, project, { type: 'none' }, 130)
  expect(atPlayhead.range).toEqual({ start: 128, end: 160 })
  expect(autoCutOptions(choices, project, { type: 'section', id: 's-c1' }, 10).range).toBeUndefined()
})

it('uses only the selected clip’s media for "Selected clips", and shuffles when not matching the mood', () => {
  const project = editor.getProject()
  const clip = project.clips['c-s-c1-1']
  const options = autoCutOptions(
    { ...choices, clips: 'selected', matchMood: false },
    project,
    { type: 'clip', id: 'c-s-c1-1' },
    0,
  )
  expect(options.assetIds).toEqual(clip && 'assetId' in clip ? [clip.assetId] : null)
  expect(options).toMatchObject({ pace: 'beat', followEnergy: false, order: 'shuffled' })
  expect(
    autoCutOptions({ ...choices, clips: 'selected' }, project, { type: 'none' }, 0).assetIds,
  ).toBeUndefined()
})

it('cuts every clip but the ones left out for "Choose clips", including clips imported after the choice', () => {
  const project = editor.getProject()
  const pool = autoCutAssets(project).map((a) => a.id)
  expect(pool.length).toBeGreaterThan(2)
  const [first, second] = pool as [string, string]
  const chosen = (leftOut: string[]) =>
    autoCutOptions({ ...choices, clips: 'chosen', leftOut }, editor.getProject(), { type: 'none' }, 0)
      .assetIds
  expect(chosen([first, second])).toEqual(pool.slice(2))
  // Ids of clips no longer in the project change nothing.
  expect(chosen(['gone', first])).toEqual(pool.slice(1))
  // Nothing left out cuts the whole library, as "All clips" does; everything left out cuts nothing.
  expect(chosen([])).toBeUndefined()
  expect(chosen(pool)).toEqual([])

  const video = project.assets[first]!
  const createdAt = '2999-01-01T00:00:00.000Z'
  editor.dispatch({ type: 'asset.add', asset: { ...video, id: 'later', name: 'Imported later', createdAt } })
  expect(chosen([first])).toEqual([...pool.slice(1), 'later'])
})

it('saves the clip choice with the project, with no undo step, so another project starts from its own', () => {
  const pool = autoCutAssets(editor.getProject()).map((a) => a.id)
  const undo = editor.undoLabel()
  setClipChoice({ clips: 'chosen', leftOut: [pool[0]!] })
  expect(editor.undoLabel()).toBe(undo)
  const saved = structuredClone(editor.getProject())

  // A fresh copy of the sample has the same asset ids, and still cuts every clip.
  loadDemoProject()
  expect(clipChoice(editor.getProject())).toEqual({ clips: 'all', leftOut: [] })
  expect(
    autoCutOptions(
      { ...choices, ...clipChoice(editor.getProject()) },
      editor.getProject(),
      { type: 'none' },
      0,
    ).assetIds,
  ).toBeUndefined()

  // Reopened, the project keeps its choice.
  editor.load(saved)
  expect(clipChoice(editor.getProject())).toEqual({ clips: 'chosen', leftOut: [pool[0]] })
  expect(
    autoCutOptions(
      { ...choices, ...clipChoice(editor.getProject()) },
      editor.getProject(),
      { type: 'none' },
      0,
    ).assetIds,
  ).toEqual(pool.slice(1))
})
it('lists the clips in the order the cut pools them, also after a removed clip comes back', () => {
  const first = autoCutAssets(editor.getProject())[0]!
  editor.dispatch({ type: 'asset.remove', assetId: first.id })
  editor.undo()
  const project = editor.getProject()
  expect(Object.keys(project.assets).at(-1)).toBe(first.id)
  expect(autoCutAssets(project).map((a) => a.id)).toEqual(autoCutPool(project).map((p) => p.assetId))
})
it('uses the media of every selected clip for "Selected clips", each once', () => {
  const project = editor.getProject()
  const media = Object.values(project.clips).filter(
    (c): c is Extract<typeof c, { assetId: string }> => c.type === 'video' || c.type === 'image',
  )
  const a = media[0]!
  const sameAsset = media.find((c) => c.id !== a.id && c.assetId === a.assetId)!
  const other = media.find((c) => c.assetId !== a.assetId)!
  expect(sameAsset).toBeDefined()
  const options = autoCutOptions(
    { ...choices, clips: 'selected' },
    project,
    { type: 'clip', id: other.id, ids: [a.id, sameAsset.id, other.id] },
    0,
  )
  expect(options.assetIds).toEqual([a.assetId, other.assetId])
})

it('counts the clips still to analyze among the clips a cut uses', () => {
  const project = editor.getProject()
  const pool = autoCutAssets(project).map((a) => a.id)
  expect(analysisBacklog(project, null).waiting).toBe(pool.length)
  expect(analysisBacklog(project, null, pool.slice(0, 2)).waiting).toBe(2)
  const failed = [{ assetId: pool[0]!, name: 'a.mp4', message: 'Could not read this media file.' }]
  const indexing: IndexingState = { status: 'idle', total: 0, done: 0, failed }
  expect(analysisBacklog(project, indexing, pool.slice(0, 2))).toEqual({ waiting: 1, unreadable: failed })
})
it('undoes an auto-cut only while it is the latest edit', async () => {
  const before = editor.getProject()
  const first = await autoCut({ editor }, { pace: 'bar' })
  expect(first.stats.cuts).toBeGreaterThan(0)
  expect(undoAutoCut(first)).toBe(true)
  expect(editor.getProject().tracks).toEqual(before.tracks)

  const second = await autoCut({ editor }, { pace: 'bar' })
  editor.dispatch({ type: 'project.rename', name: 'Renamed' }, { label: 'Rename project' })
  expect(undoAutoCut(second)).toBe(false)
  expect(editor.getProject().tracks.some((t) => t.name === 'Auto-cut')).toBe(true)
})

it('counts clips footage analysis has not indexed for matching', () => {
  const project = editor.getProject()
  const total = unanalyzedClipCount(project)
  expect(total).toBeGreaterThan(1)
  const assetId = Object.values(project.assets).find((a) => a.kind === 'video')!.id
  editor.dispatch(
    {
      type: 'analysis.setVisual',
      analysis: { assetId, version: 'vision-1', data: { embedding: { model: 'm' } } },
    },
    { history: 'skip' },
  )
  expect(unanalyzedClipCount(editor.getProject())).toBe(total - 1)
})

it('says why clips were cut without matching when footage analysis stopped, was cancelled or couldn’t read them', () => {
  const state = (patch: Partial<IndexingState>): IndexingState => ({
    status: 'idle',
    total: 0,
    done: 0,
    failed: [],
    ...patch,
  })
  const stopped = (code: JobErrorCode) => state({ status: 'error', error: { code, message: 'technical' } })
  expect(unanalyzedWarning(['a', 'b'], true, stopped('out-of-memory'))).toBe(
    'Footage analysis ran out of memory, so your clips were picked for variety. Try again in Match footage, then cut again to match the mood.',
  )
  expect(unanalyzedWarning(['a'], true, stopped('network'))).toBe(
    'Footage analysis couldn’t finish its download, so your clip was picked for variety. Check your connection and try again in Match footage, then cut again to match the mood.',
  )
  expect(unanalyzedWarning(['a', 'b'], false, stopped('internal'))).toBe(
    'Footage analysis stopped, so 2 clips were picked for variety. Try again in Match footage, then cut again to match the mood.',
  )
  expect(unanalyzedWarning(['a'], false, state({ status: 'paused' }))).toBe(
    'Footage analysis was cancelled, so 1 clip was picked for variety. Analyze your footage in Match footage, then cut again to match the mood.',
  )
  expect(unanalyzedWarning(['a'], true, stopped('storage-quota'))).toBe(
    'Footage analysis ran out of browser storage, so your clip was picked for variety. Free space in Settings › Storage and try again in Match footage, then cut again to match the mood.',
  )
  expect(unanalyzedWarning(['a'], true, stopped('unsupported'))).toBe(
    'Footage analysis can’t run in this browser, so your clip was picked for variety.',
  )
  expect(unanalyzedWarning(['a'], true, stopped('model-load'))).toBe(
    'Footage analysis couldn’t start, so your clip was picked for variety. Try again in Match footage, then cut again to match the mood.',
  )
  const failed = [
    { assetId: 'a', name: 'beach.mp4', message: 'Could not read this media file.' },
    { assetId: 'b', name: 'night.mov', message: 'Could not read this media file.' },
  ]
  expect(unanalyzedWarning(['a'], false, state({ failed }))).toBe(
    '“beach.mp4” couldn’t be analyzed, so it was picked for variety.',
  )
  const long = [{ ...failed[0]!, name: 'my_holiday_footage_from_the_beach_2024_final_version_v2.mp4' }]
  expect(unanalyzedWarning(['a'], true, state({ failed: long }))).toBe(
    '“my_holiday_foot…_v2.mp4” couldn’t be analyzed, so it was picked for variety.',
  )
  expect(unanalyzedWarning(['a', 'b'], true, state({ failed }))).toBe(
    'Your clips couldn’t be analyzed, so they were picked for variety.',
  )
  // Clips still waiting for a running analysis keep the default note.
  expect(unanalyzedWarning(['a', 'c'], false, state({ status: 'indexing', failed }))).toBeUndefined()
  expect(unanalyzedWarning(['c'], true, state({}))).toBeUndefined()
  expect(unanalyzedWarning(['a'], true, null)).toBeUndefined()
})

it('passes the More options through: where cuts land, and story order over the mood switch', () => {
  const project = editor.getProject()
  expect(autoCutOptions(choices, project, { type: 'none' }, 0)).toMatchObject({
    cutOn: 'beats',
    order: 'matched',
  })
  expect(autoCutOptions({ ...choices, cutOn: 'sections' }, project, { type: 'none' }, 0).cutOn).toBe(
    'sections',
  )
  const story = { ...choices, clipOrder: 'story' as const }
  expect(autoCutOptions(story, project, { type: 'none' }, 0).order).toBe('chronological')
  expect(autoCutOptions({ ...story, matchMood: false }, project, { type: 'none' }, 0).order).toBe(
    'chronological',
  )
  expect(matchesMood(choices)).toBe(true)
  expect(matchesMood(story)).toBe(false)
  expect(matchesMood({ ...choices, matchMood: false })).toBe(false)
})

describe('the auto-cut job', () => {
  let refine: () => Promise<RefinedFields>
  let found: RefinedFields

  beforeEach(() => {
    setSongAnalysisServiceForTests({
      refine: () =>
        jobs.run({
          kind: 'analysis.downbeats',
          title: 'Finding bars and refining beats',
          run: () => refine(),
        }),
      release: async () => undefined,
    })
    const project = editor.getProject()
    const { downbeats, ...analysis } = project.analysis.audio[project.songAssetId!]!
    found = { tempo: analysis.tempo, beats: analysis.beats, downbeats }
    editor.dispatch({ type: 'analysis.setAudio', analysis }, { history: 'skip' })
  })

  async function cut() {
    const handle = startAutoCut({ pace: 'bar' })!
    const stages = new Set<string | undefined>()
    handle.subscribe((s) => stages.add(s.progress.stage))
    return { result: await handle.promise, stages }
  }

  it('finds the song’s bars first when they are not found yet', async () => {
    refine = () => Promise.resolve(found)
    const { result, stages } = await cut()
    expect(stages.has('bars')).toBe(true)
    expect(barsState().status).toBe('ready')
    expect(result.stats.cuts).toBeGreaterThan(0)
    expect(result.warnings.join(' ')).not.toMatch(/Bars not found yet/)
  })

  it('cuts on the beats and says so when the bars cannot be found', async () => {
    refine = () => Promise.reject(new JobError('model-load', 'The beat model could not load'))
    const { result } = await cut()
    expect(barsState().status).toBe('unavailable')
    expect(result.stats.cuts).toBeGreaterThan(0)
    expect(result.warnings).toContain(
      'Bars not found yet, so the cuts follow the beats. Analyze again in Assist › Song analysis to look for them.',
    )
  })
})
