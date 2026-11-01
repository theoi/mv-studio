import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clipsNoun,
  clipsSinceDraft,
  directorRequest,
  draftProgress,
  useDirector,
  videoKindFor,
} from '../../../src/app/state/director.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { dismissToast, get as getUi, set as setUi } from '../../../src/app/state/ui.ts'
import type { DirectorState } from '../../../src/director/index.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset, AssetOrigin } from '../../../src/model/types.ts'
import { createFromTemplate } from '../../../src/plugins/templates.ts'
import type { JobSnapshot } from '../../../src/shared/jobs.ts'

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
