import { create } from 'zustand'
import type {
  DirectorRequest,
  DirectorSession,
  DirectorState,
  PlanCost,
  PlanDescription,
  VideoKind,
} from '../../director/index.ts'
import type { Id } from '../../model/types.ts'
import { pluginRegistry } from '../../engine/registry.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import type { Asset, Project } from '../../model/index.ts'
import { templateState } from '../../plugins/templates.ts'
import { JobError, jobs, type JobSnapshot } from '../../shared/jobs.ts'
import { isBlankClip } from '../../vision/analysisData.ts'
import { cloudServices, cloudSettings, spendLedger } from './cloud.ts'
import { unanalyzedWarning } from './autocut.ts'
import { checkClipsForBlank, directorFootage, footageAnalysisRuns, useFootage } from './footage.ts'
import { appMedia } from './media.ts'
import { songAnalysisRunning } from './importer.ts'
import { JOB_KINDS } from './jobs.ts'
import { plural } from '../format.ts'
import { holdThumbnailsForDraft } from '../screens/editor/stage.ts'
import { editor } from './project.ts'
import { ensureBars } from './songAnalysis.ts'
import { dismissToast, get as getUi, set as setUi, toast, type Kind } from './ui.ts'

/*
 * Assist › Director: one DirectorSession for the app. The director code loads on first use. A draft that costs
 * nothing is applied as soon as it is planned; a draft with AI shots waits for the user to see the price.
 */

/** Where shots come from: the user's clips, clips plus AI shots, or AI shots only. */
export type ShotSource = 'mine' | 'mix' | 'gen'

/** What AI shots are: stills the director animates with camera moves, or video clips (they cost more). */
export type AiShots = 'images' | 'video'

interface DirectorUi {
  state: DirectorState
  /** What the panel shows for the plan in the current state. */
  description: PlanDescription | null
  idea: string
  shots: ShotSource
  aiShots: AiShots
  /** fal.ai's note about what Cancel can and can't stop, shown while shots generate. */
  cancelNotice: string
  /** A free draft is planned and about to go on the timeline. */
  applying: boolean
  /** The last planning job, so its finished progress stays on screen while a free draft is applied. */
  planJobId?: string
  /** The project the last draft was planned in, and the user's clips and images in it then (see clipsSinceDraft()). */
  clipsAtDraft?: { projectId: Id; ids: Id[] }
}

export const useDirector = create<DirectorUi>(() => ({
  state: { status: 'idle' },
  description: null,
  idea: '',
  shots: 'mine',
  aiShots: 'images',
  cancelNotice: '',
  applying: false,
}))

/** Set while a draft started from the panel is planned: one that costs nothing is applied right away. */
let autoApply = false

let session: Promise<DirectorSession> | undefined

function directorSession(): Promise<DirectorSession> {
  session ??= Promise.all([
    import('../../director/index.ts'),
    cloudServices(),
    import('../../cloud/fal/provider.ts'),
  ]).then(([d, cloud, fal]) => {
    const s = new d.DirectorSession({
      editor,
      jobs,
      provider: () => cloud.generation(),
      store: mediaStore,
      media: appMedia,
      readAsset: async (assetId) => {
        const asset = editor.getProject().assets[assetId]
        if (!asset) throw new Error('That media is no longer in the project.')
        return appMedia.getFile(asset)
      },
      footage: () => directorFootage()?.ranker,
      matcher: () => directorFootage()?.matcher,
      catalog: () => d.catalogFromPlugins(pluginRegistry.catalog()),
      spendPolicy: () => cloudSettings.get(),
      ledger: spendLedger,
      ensureBars,
      waitForSong,
      checkClips: checkClipsForBlank,
      unanalyzedWarning: (ids, all) =>
        unanalyzedWarning(ids, all, useFootage.getState().indexing, { analysisRuns: footageAnalysisRuns() }),
      planner: d.createDirectorPlanner({
        client: () => cloud.llm(),
        model: () => cloudSettings.get().llm?.model,
      }),
      // The planner falls back to the built-in one when there is no model to ask.
      plansWithModel: () => Boolean(cloud.llm()),
    })
    s.subscribe(() => {
      const state = s.getState()
      useDirector.setState({
        state,
        ...(state.status === 'planning' ? { planJobId: state.jobId } : {}),
        applying: autoApply && state.status === 'ready' && !paidCost(state.cost),
        description: 'plan' in state && state.plan ? d.describePlan(state.plan, editor.getProject()) : null,
      })
    })
    useDirector.setState({ cancelNotice: fal.FAL_CANCEL_NOTICE })
    return s
  })
  return session
}

/** Waits for the song analysis still running (a draft right after the setup screen), with its job's progress. */
async function waitForSong({
  signal,
  progress,
}: {
  signal: AbortSignal
  progress: (fraction: number) => void
}) {
  const songId = editor.getProject().songAssetId
  const run = songId ? songAnalysisRunning(songId) : undefined
  if (!run) return
  let last: number | undefined
  const report = () => {
    const job = jobs.list().find((j) => j.kind === JOB_KINDS.analysis && j.status === 'running')
    const fraction = job?.progress.fraction ?? 0
    // The plan's own progress also notifies job listeners: report only the analysis's changes, or this would loop.
    if (fraction === last) return
    last = fraction
    progress(fraction)
  }
  report()
  const unsubscribe = jobs.subscribe(report)
  try {
    await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        const stop = () => reject(new JobError('cancelled', 'Cancelled'))
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      }),
    ])
  } finally {
    unsubscribe()
  }
}

/**
 * The kind of video to draft: the kind the project was made as, else the editor's (a blank project picks from what
 * it has). The editor's kind comes from the link, so a project reopened without one would otherwise draft as a lyric
 * video.
 */
export function videoKindFor(uiKind: Kind, project: Project): VideoKind {
  const kind = templateState(project)?.kind ?? uiKind
  if (kind === 'footage') return 'beat-cut'
  if (kind !== 'blank') return kind
  if (project.lyrics?.lines.some((l) => l.text.trim())) return 'lyric'
  if (
    Object.values(project.assets).some(
      (a) => a.kind === 'video' && a.origin.type === 'import' && !isBlankClip(project.analysis.visual[a.id]),
    )
  )
    return 'beat-cut'
  return 'visualizer'
}

export function directorRequest(
  idea: string,
  shots: ShotSource,
  aiShots: AiShots = 'images',
): DirectorRequest {
  return {
    kind: videoKindFor(getUi().kind, editor.getProject()),
    ...(idea.trim() ? { prompt: idea.trim() } : {}),
    useMedia: shots !== 'gen',
    ...(shots === 'mine' ? {} : { generate: { mode: aiShots, tier: 'draft' as const } }),
  }
}

/** The cost only when something will be paid for; a plan that reuses earlier AI shots is free. */
export function paidCost(cost: PlanCost | null | undefined): PlanCost | null {
  return cost && cost.count > 0 ? cost : null
}

async function applyIfFree(state: DirectorState) {
  try {
    if (state.status === 'ready' && !paidCost(state.cost)) await applyDraft()
  } finally {
    autoApply = false
    useDirector.setState({ applying: false })
  }
}

/** The clips and images the user imported, which a draft from their media uses. */
function userClips(project: Project): Asset[] {
  return Object.values(project.assets).filter(
    (a) => (a.kind === 'video' || a.kind === 'image') && a.origin.type === 'import',
  )
}

/**
 * Clips and images imported after the applied draft was planned, when the draft takes the user's media. None in
 * another project: the director's result stays on screen when one opens, but its request is the other project's.
 */
export function clipsSinceDraft(project: Project, ui: Pick<DirectorUi, 'state' | 'clipsAtDraft'>): Asset[] {
  const at = ui.clipsAtDraft
  if (ui.state.status !== 'applied' || !ui.state.request.useMedia || at?.projectId !== project.id) return []
  const before = new Set(at.ids)
  return userClips(project).filter((a) => !before.has(a.id))
}

function clipsNow(): DirectorUi['clipsAtDraft'] {
  const project = editor.getProject()
  return { projectId: project.id, ids: userClips(project).map((a) => a.id) }
}

/** "2 clips", "1 image", "2 clips and 1 image". */
export function clipsNoun(assets: Asset[]): string {
  const clips = assets.filter((a) => a.kind === 'video').length
  const images = assets.length - clips
  return [clips ? plural(clips, 'clip') : '', images ? plural(images, 'image') : '']
    .filter(Boolean)
    .join(' and ')
}

/** Plans a draft; one that costs nothing goes on the timeline right away. */
export async function draftVideo(request: DirectorRequest): Promise<void> {
  const s = await directorSession()
  autoApply = true
  useDirector.setState({ clipsAtDraft: clipsNow() })
  await applyIfFree(await s.plan(request))
}

/** Plans again with another seed: different clips, prompts and camera moves. */
export async function tryAnotherVersion(): Promise<void> {
  const s = await directorSession()
  autoApply = true
  useDirector.setState({ clipsAtDraft: clipsNow() })
  await applyIfFree(await s.tryAnother())
}

let clipsOffered = 0

/**
 * Clips imported after a draft that uses the user's media aren't in it: offers to draft again, once per new batch. A
 * new import replaces the offer instead of stacking another one, and while the Director panel is open its own callout
 * makes the offer. The offer goes when nothing is left to add, as when another project opens.
 */
function offerNewClips(project: Project): void {
  const ui = useDirector.getState()
  const { state } = ui
  const added = clipsSinceDraft(project, ui)
  if (!added.length) {
    const offer = getUi().toasts.find((t) => t.key === NEW_CLIPS)
    if (offer) dismissToast(offer.id)
  }
  if (state.status !== 'applied' || added.length <= clipsOffered) {
    clipsOffered = Math.min(clipsOffered, added.length)
    return
  }
  clipsOffered = added.length
  const { rightTab, assistView } = getUi()
  if (rightTab === 'assist' && assistView === 'director') return
  const { request } = state
  toast(
    `${clipsNoun(added)} added after the draft. Draft again to use ${added.length === 1 ? 'it' : 'them'}?`,
    { label: 'Draft again', run: () => void draftVideo(request) },
    { key: NEW_CLIPS },
  )
}

const NEW_CLIPS = 'director:new-clips'

editor.subscribe(offerNewClips)

/** Stops waiting for the AI model and drafts with the built-in planner. */
export async function draftLocally(): Promise<void> {
  const s = await directorSession()
  autoApply = true
  await applyIfFree(await s.useLocalDraft())
}

/** Applies the plan: generates AI shots first unless skipped (the panel has asked about the cost). */
export async function applyDraft(options: { confirmSpend?: boolean; skipGeneration?: boolean } = {}) {
  const s = await directorSession()
  try {
    // Loaded with the session already.
    const { openingFrame } = await import('../../director/index.ts')
    // Where beforeApply moved the playhead from and to (-1 while it hasn't).
    const moved = { from: 0, to: -1 }
    const state = await s.apply({
      ...options,
      // Before the draft is on the timeline: moved after, the preview would first seek the draft's clips for the black
      // first frame of its fade from black, and seek them again for the opening once that frame is drawn.
      beforeApply: (plan) => {
        const opening = openingFrame(plan)
        const from = getUi().playhead
        if (from >= opening) return
        Object.assign(moved, { from, to: opening })
        setUi({ playhead: opening })
      },
    })
    if (state.status !== 'applied') {
      // The draft's edits failed once the playhead had moved for them: it goes back, unless it was moved since.
      if (getUi().playhead === moved.to) setUi({ playhead: moved.from })
      return
    }
    // Straight after the dispatch, before the timeline's frame thumbnails of the draft's clips start decoding.
    holdThumbnailsForDraft()
    toast('Your draft is on the timeline', { label: 'Undo', run: () => void undoDraft() })
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error))
  }
}

/** Removes the applied draft while it is still the latest change. A free draft returns the panel to its start. */
export async function undoDraft(): Promise<boolean> {
  const s = await directorSession()
  if (!s.undo()) {
    toast('The draft has changed since. Use Undo in the top bar to step back.')
    return false
  }
  // A draft with AI shots stays on its plan, so applying it again reuses the shots instead of paying again.
  const state = s.getState()
  if (state.status === 'ready' && !paidCost(state.cost) && state.generatedShots === 0) s.reset()
  toast('Draft removed from the timeline')
  return true
}

export function cancelDirector(): void {
  void directorSession().then((s) => s.cancel())
}

/** From a failed generation, back to the plan with its price. */
export function backToPlan(): void {
  void directorSession().then((s) => s.backToPlan())
}

/** Shows the user's tracks that a draft hid, as one undo step. */
export function showTracks(trackIds: Id[]): void {
  const hidden = editor.getProject().tracks.filter((t) => t.hidden && trackIds.includes(t.id))
  if (!hidden.length) return
  editor.dispatch(
    hidden.map((t) => ({ type: 'track.update' as const, trackId: t.id, patch: { hidden: false } })),
    { label: 'Show your tracks' },
  )
}

/** Back to the start of the panel. AI shots already made stay in the project's media and are reused. */
export function resetDirector(): void {
  void directorSession().then((s) => s.reset())
}

/** Drafts the same video again with AI shots, as the setup screen does once fal.ai is connected. The price shows first. */
export function draftWithAiShots(request: DirectorRequest): void {
  useDirector.setState({ shots: 'mix' })
  void draftVideo({
    ...request,
    useMedia: true,
    generate: { mode: useDirector.getState().aiShots, tier: 'draft' },
  })
}

/** From the setup screen: drafts with the idea, with AI shots when fal.ai is connected (the price is shown first). */
export function draftFromSetup(idea: string): void {
  const shots: ShotSource = cloudSettings.get().falKey ? 'mix' : 'mine'
  useDirector.setState({ idea, shots })
  void draftVideo(directorRequest(idea, shots))
}

/**
 * The draft's job as the Director card shows it: while it waits for the song analysis, with that job's progress, as
 * the top bar shows it, so the one wait has one number (the draft's own bar gives the wait only its first quarter).
 */
export function draftProgress(job: JobSnapshot | undefined, list: JobSnapshot[]): JobSnapshot | undefined {
  if (job?.progress.stage !== 'song') return job
  const analysis = list.find((j) => j.kind === JOB_KINDS.analysis && j.status === 'running')
  return analysis ? { ...job, progress: { ...job.progress, fraction: analysis.progress.fraction } } : job
}
