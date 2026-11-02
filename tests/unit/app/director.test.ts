import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDraft,
  clipsNoun,
  clipsSinceDraft,
  directorRequest,
  draftProgress,
  draftVideo,
  heldDraftOf,
  lastSeed,
  rememberSeed,
  useDirector,
  videoKindFor,
} from '../../../src/app/state/director.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { heldDraft } from '../../../src/app/state/leaveDraft.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { dismissToast, get as getUi, set as setUi } from '../../../src/app/state/ui.ts'
import type { DirectorState, PlanCost } from '../../../src/director/index.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset, AssetOrigin, Project } from '../../../src/model/types.ts'
import { createFromTemplate } from '../../../src/plugins/templates.ts'
import { jobs, type JobSnapshot } from '../../../src/shared/jobs.ts'
import { CLIPS, makeProject, type ClipSpec } from '../vision/autocut/fixtures.ts'

const job = (
  kind: string,
  fraction: number | undefined,
  stage?: string,
  status: JobSnapshot['status'] = 'running',
) => ({ id: kind, kind, title: kind, status, progress: { fraction, stage } }) as JobSnapshot

describe('draftProgress', () => {
  it('shows the song analysis’s progress while the draft waits for it, as the top bar does', () => {
    const draft = job('director.plan', 0.09, 'song')
    const analysis = job(JOB_KINDS.analysis, 0.35)
    expect(draftProgress(draft, [analysis, draft])?.progress).toEqual({ fraction: 0.35, stage: 'song' })
  })

  it('shows the draft’s own progress in its other stages, or without a running analysis', () => {
    const planning = job('director.plan', 0.4, 'plan')
    const waiting = job('director.plan', 0.2, 'song')
    const analysis = job(JOB_KINDS.analysis, 0.35)
    expect(draftProgress(planning, [analysis, planning])).toBe(planning)
    expect(draftProgress(waiting, [job(JOB_KINDS.analysis, 1, undefined, 'succeeded'), waiting])).toBe(
      waiting,
    )
    expect(draftProgress(undefined, [analysis])).toBeUndefined()
  })
})

describe('directorRequest', () => {
  it('asks for AI video clips or images as chosen, and for none with My clips', () => {
    expect(directorRequest('neon city', 'gen', 'video')).toMatchObject({
      prompt: 'neon city',
      useMedia: false,
      generate: { mode: 'video', tier: 'draft' },
    })
    expect(directorRequest('', 'mix', 'video').generate?.mode).toBe('video')
    expect(directorRequest('', 'mix').generate?.mode).toBe('images')
    expect(directorRequest('', 'mine', 'video').generate).toBeUndefined()
  })
})

describe('videoKindFor', () => {
  it('drafts the kind the project was made as, whatever kind the link gave the editor', () => {
    expect(videoKindFor('lyric', createFromTemplate('ai'))).toBe('ai')
    expect(videoKindFor('lyric', createFromTemplate('footage'))).toBe('beat-cut')
    expect(videoKindFor('ai', createFromTemplate('lyric'))).toBe('lyric')
  })

  it('takes the editor’s kind for a project made without a starter template', () => {
    expect(videoKindFor('visualizer', createProject({ name: 'Imported' }))).toBe('visualizer')
  })

  const noLyrics = (clips: ClipSpec[]): Project => {
    const project = makeProject({ clips })
    return { ...project, lyrics: { ...project.lyrics!, lines: [] } }
  }

  it('drafts a blank project as a beat cut of its clips, unless they all show nothing', () => {
    expect(videoKindFor('blank', noLyrics(CLIPS))).toBe('beat-cut')
    expect(videoKindFor('blank', noLyrics(CLIPS.map((c) => ({ ...c, blank: c.id !== 'ocean' }))))).toBe(
      'beat-cut',
    )
    expect(videoKindFor('blank', noLyrics(CLIPS.map((c) => ({ ...c, blank: true }))))).toBe('visualizer')
  })
})

describe('clips imported after a draft', () => {
  const asset = (id: string, kind: Asset['kind'], origin: AssetOrigin['type'] = 'import'): Asset => ({
    id,
    kind,
    name: `${id}.${kind === 'image' ? 'png' : 'mp4'}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    byteSize: 1,
    storageKey: `media/${id}`,
    origin: { type: origin },
    createdAt: new Date(0).toISOString(),
  })
  const applied = (useMedia: boolean) =>
    ({ status: 'applied', request: { kind: 'ai', useMedia } }) as unknown as DirectorState
  const offers = () =>
    getUi()
      .toasts.filter((t) => t.key === 'director:new-clips')
      .map((t) => t.message)

  /** The draft's snapshot of the clips in the open project now. */
  const atDraft = () => {
    const project = editor.getProject()
    return { projectId: project.id, ids: Object.keys(project.assets) }
  }

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })
    loadDemoProject()
    setUi({ toasts: [], rightTab: 'inspector' })
    useDirector.setState({ state: { status: 'idle' }, clipsAtDraft: undefined })
  })

  it('lists the clips and images imported since the draft, not generated shots, masks or audio', () => {
    useDirector.setState({ state: applied(true), clipsAtDraft: atDraft() })
    editor.dispatch([
      { type: 'asset.add', asset: asset('new-clip', 'video') },
      { type: 'asset.add', asset: asset('new-still', 'image') },
      { type: 'asset.add', asset: asset('ai-shot', 'image', 'generated') },
      { type: 'asset.add', asset: asset('mask', 'video', 'derived') },
      { type: 'asset.add', asset: asset('voice', 'audio') },
    ])
    const added = clipsSinceDraft(editor.getProject(), useDirector.getState())
    expect(added.map((a) => a.id).sort()).toEqual(['new-clip', 'new-still'])
    expect(clipsNoun(added)).toBe('1 clip and 1 image')
    expect(clipsNoun([...added, asset('another', 'video')])).toBe('2 clips and 1 image')
    expect(clipsNoun(added.filter((a) => a.kind === 'image'))).toBe('1 image')
    expect(clipsNoun(added.filter((a) => a.kind === 'video'))).toBe('1 clip')
  })

  it('lists none before a draft is applied, or for a draft of AI shots only', () => {
    editor.dispatch({ type: 'asset.add', asset: asset('new-clip', 'video') })
    const before = { projectId: editor.getProject().id, ids: [] }
    expect(clipsSinceDraft(editor.getProject(), { state: { status: 'idle' }, clipsAtDraft: before })).toEqual(
      [],
    )
    expect(clipsSinceDraft(editor.getProject(), { state: applied(false), clipsAtDraft: before })).toEqual([])
  })

  it('offers to draft again once per import, in one notice that newer imports update', () => {
    useDirector.setState({ state: applied(true), clipsAtDraft: atDraft() })
    editor.dispatch({ type: 'asset.add', asset: asset('first', 'video') })
    expect(offers()).toEqual(['1 clip added after the draft. Draft again to use it?'])
    expect(getUi().toasts.find((t) => t.key === 'director:new-clips')?.action?.label).toBe('Draft again')
    // Dismissed, it stays away through other edits.
    dismissToast(getUi().toasts.find((t) => t.key === 'director:new-clips')!.id)
    editor.dispatch({ type: 'project.rename', name: 'Renamed' })
    expect(offers()).toEqual([])
    editor.dispatch({ type: 'asset.add', asset: asset('second', 'video') })
    expect(offers()).toEqual(['2 clips added after the draft. Draft again to use them?'])
  })

  it('leaves the offer to the Director panel while it is open', () => {
    useDirector.setState({ state: applied(true), clipsAtDraft: atDraft() })
    setUi({ rightTab: 'assist', assistView: 'director' })
    editor.dispatch({ type: 'asset.add', asset: asset('first', 'video') })
    expect(offers()).toEqual([])
    setUi({ rightTab: 'inspector' })
    editor.dispatch({ type: 'asset.add', asset: asset('second', 'image') })
    expect(offers()).toEqual(['1 clip and 1 image added after the draft. Draft again to use them?'])
  })

  it('offers nothing in another project, and takes the offer back when one opens', () => {
    useDirector.setState({ state: applied(true), clipsAtDraft: atDraft() })
    editor.dispatch({ type: 'asset.add', asset: asset('first', 'video') })
    expect(offers()).toHaveLength(1)
    // Its Draft again would draft the other project with this one's request.
    editor.load(createProject({ name: 'Beat cut', fps: 30 }))
    expect(offers()).toEqual([])
    editor.dispatch({ type: 'asset.add', asset: asset('theirs', 'image') })
    expect(clipsSinceDraft(editor.getProject(), useDirector.getState())).toEqual([])
    expect(offers()).toEqual([])
  })
})

describe('another project opening', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })
    loadDemoProject()
    setUi({ toasts: [] })
    useDirector.setState({
      state: { status: 'idle' },
      idea: 'neon night drive',
      shots: 'mix',
      aiShots: 'video',
      planJobId: 'plan-1',
      clipsAtDraft: { projectId: editor.getProject().id, ids: [] },
    })
  })

  const openAnother = () => editor.load(createProject({ name: 'Other', fps: 30 }))
  const plans = () => jobs.list().filter((j) => j.kind === 'director.plan').length

  it('clears the idea and the last draft at once, keeping where shots come from and whether AI shots are images or video', () => {
    openAnother()
    const ui = useDirector.getState()
    expect(ui).toMatchObject({ idea: '', applying: false, shots: 'mix', aiShots: 'video' })
    expect(ui.planJobId).toBeUndefined()
    expect(ui.clipsAtDraft).toBeUndefined()
  })

  it('keeps everything when the same project loads again', () => {
    editor.load(structuredClone(editor.getProject()))
    expect(useDirector.getState()).toMatchObject({ idea: 'neon night drive', planJobId: 'plan-1' })
  })

  it('drops a draft asked for in the project that was open when the Director started loading', async () => {
    const before = plans()
    const drafting = draftVideo(directorRequest('', 'mine'))
    openAnother()
    await drafting
    expect(plans()).toBe(before)
    expect(useDirector.getState().clipsAtDraft).toBeUndefined()
  })

  it('says there is no plan to apply when Apply is pressed without one', async () => {
    await applyDraft()
    expect(getUi().toasts.map((t) => t.message)).toEqual(['Make a plan first.'])
  })
  it('says nothing when Apply was pressed in the project open before another opened', async () => {
    const applying = applyDraft()
    openAnother()
    await applying
    expect(getUi().toasts.map((t) => t.message)).toEqual([])
  })
})

describe('a draft that leaving the project would lose', () => {
  const state = (s: Record<string, unknown>) => s as unknown as DirectorState
  const cost = (count: number, reused: number) => ({ count, reused }) as unknown as PlanCost

  it('holds the AI shots made for a draft not on the timeline, after Stop or a failed generation', () => {
    const stopped = state({ status: 'ready', plan: {}, generatedShots: 2, unit: 'clip', cost: cost(3, 1) })
    expect(heldDraftOf(stopped)).toEqual({ kind: 'unapplied', unit: 'clip', made: 2, missing: 4 })
    const failed = state({ status: 'error', plan: {}, generatedShots: 1, unit: 'shot', cost: null })
    expect(heldDraftOf(failed)).toEqual({ kind: 'unapplied', unit: 'shot', made: 1, missing: 0 })
  })

  it('holds the failed shots of a draft on the timeline, waiting for Retry', () => {
    const applied = state({ status: 'applied', plan: {}, failedShots: 2, unit: 'clip' })
    expect(heldDraftOf(applied)).toEqual({ kind: 'failed', unit: 'clip', failed: 2 })
  })

  it('holds nothing before any shot is made, once the draft is complete, or while it is planned or generated', () => {
    expect(
      heldDraftOf(state({ status: 'ready', plan: {}, generatedShots: 0, unit: 'shot', cost: cost(4, 0) })),
    ).toBeNull()
    expect(heldDraftOf(state({ status: 'applied', plan: {}, failedShots: 0, unit: 'shot' }))).toBeNull()
    expect(heldDraftOf(state({ status: 'error', generatedShots: 0, unit: 'shot', cost: null }))).toBeNull()
    expect(heldDraftOf(state({ status: 'generating', plan: {}, done: 2, unit: 'clip' }))).toBeNull()
    expect(heldDraftOf({ status: 'idle' })).toBeNull()
  })

  it('is what the question before leaving asks about', () => {
    useDirector.setState({ state: state({ status: 'applied', plan: {}, failedShots: 1, unit: 'shot' }) })
    expect(heldDraft()).toEqual({ kind: 'failed', unit: 'shot', failed: 1 })
    useDirector.setState({ state: { status: 'idle' } })
    expect(heldDraft()).toBeNull()
  })
})

describe('the seed of a project’s last plan', () => {
  beforeEach(() => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    })
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })
    loadDemoProject()
    useDirector.setState({ state: { status: 'idle' } })
  })

  it('is kept per project, for the 50 projects planned in last', () => {
    rememberSeed('first', 3)
    rememberSeed('second', 2)
    expect([lastSeed('first'), lastSeed('second'), lastSeed('other')]).toEqual([3, 2, undefined])
    rememberSeed('first', 4)
    for (let i = 0; i < 49; i++) rememberSeed(`p${i}`, 2)
    // "second" is the oldest now; "first" planned again after it.
    expect([lastSeed('second'), lastSeed('first'), lastSeed('p0')]).toEqual([undefined, 4, 2])
  })

  it('is what a new draft in the project plans with, and a plan keeps its own', async () => {
    const id = editor.getProject().id
    rememberSeed(id, 3)
    await draftVideo(directorRequest('', 'mine'))
    const first = useDirector.getState().state
    expect('request' in first && first.request?.seed).toBe(3)
    await draftVideo({ ...directorRequest('', 'mine'), seed: 5 })
    expect(lastSeed(id)).toBe(5)
  })
})
