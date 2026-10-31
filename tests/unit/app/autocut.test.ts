import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefinedFields } from '../../../src/analysis/song.ts'
import { autoCut } from '../../../src/vision/autocut/index.ts'
import {
  autoCutOptions,
  DEFAULT_AUTOCUT_CHOICES,
  matchesMood,
  startAutoCut,
  unanalyzedClipCount,
  undoAutoCut,
  type AutoCutChoices,
} from '../../../src/app/state/autocut.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { barsState, setSongAnalysisServiceForTests } from '../../../src/app/state/songAnalysis.ts'
import type * as Footage from '../../../src/app/state/footage.ts'
import { JobError, jobs } from '../../../src/shared/jobs.ts'

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
