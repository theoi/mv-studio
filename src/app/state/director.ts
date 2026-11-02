import { create } from 'zustand'
import type {
  DirectorRequest,
  DirectorSession,
  DirectorState,
  PlanCost,
  PlanDescription,
  VideoKind,
} from '../../director/index.ts'
import type { EditChange } from '../../model/editor.ts'
import type { Id } from '../../model/types.ts'
import { pluginRegistry } from '../../engine/registry.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import type { Asset, Project } from '../../model/index.ts'
import { templateState } from '../../plugins/templates.ts'
import { JobError, jobs, type JobSnapshot } from '../../shared/jobs.ts'
import { isBlankClip } from '../../vision/analysisData.ts'
import { cloudServices, cloudSettings, spendLedger } from './cloud.ts'
import { unanalyzedWarning } from './autocut.ts'
import {
  checkClipsForBlank,
  directorFootage,
  footageAnalysisRuns,
  holdAnalysisUntil,
  useFootage,
} from './footage.ts'
import { appMedia } from './media.ts'
import { songAnalysisRunning } from './importer.ts'
import { JOB_KINDS } from './jobs.ts'
import { holdDrafts, type HeldDraft } from './leaveDraft.ts'
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
/** The session once it has loaded, for the reset when another project opens (leaveProject()). */
let loaded: DirectorSession | undefined

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
      unanalyzedWarning: (ids, all) => {
        const assets = editor.getProject().assets
        return unanalyzedWarning(ids, all, useFootage.getState().indexing, {
          analysisRuns: footageAnalysisRuns(),
          media: clipsNoun(ids.flatMap((id) => assets[id] ?? [])),
        })
      },
      planner: d.createDirectorPlanner({
        client: () => cloud.llm(),
        model: () => cloudSettings.get().llm?.model,
      }),
      // The planner falls back to the built-in one when there is no model to ask.
      plansWithModel: () => Boolean(cloud.llm()),
    })
    s.subscribe(() => {
      const state = s.getState()
      if (state.status === 'ready' || state.status === 'applied')
        rememberSeed(editor.getProject().id, state.request.seed ?? 1)
      useDirector.setState({
        state,
        ...(state.status === 'planning' ? { planJobId: state.jobId } : {}),
        applying: autoApply && state.status === 'ready' && !paidCost(state.cost),
        description: 'plan' in state && state.plan ? d.describePlan(state.plan, editor.getProject()) : null,
      })
    })
    useDirector.setState({ cancelNotice: fal.FAL_CANCEL_NOTICE })
    loaded = s
    return s
  })
  return session
}

/** The project the Director's plan, draft and running job belong to. */
let openProject = editor.getProject().id

/**
 * Another project opened: the Director starts over there, so nothing planned, priced or drafted for the other project
 * can be applied or paid for in this one. It keeps the user's preferences (where shots come from, images or video). A
 * paid run stops as Cancel stops it, and what fal.ai has already billed stays recorded. Synchronous: the setup screen
 * starts a draft right after opening its new project.
 */
function leaveProject(project: Project, change: EditChange): void {
  if (change.source !== 'load' || project.id === openProject) return
  openProject = project.id
  autoApply = false
  loaded?.reset()
  useDirector.setState({ idea: '', applying: false, planJobId: undefined, clipsAtDraft: undefined })
}

editor.subscribe(leaveProject)

/** False once another project has opened since `projectId` was the open one. */
const stillOpen = (projectId: Id) => editor.getProject().id === projectId

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

/** Clips and images imported after the applied draft was planned, when the draft takes the user's media. */
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

/**
 * The longest a draft's planning holds footage analysis. Planning ranks the clips on the model worker that analysis
 * keeps busy, so a draft took about twice as long while analysis ran, but a slow AI model's plan mustn't stop it for
 * long.
 */
const PLAN_ANALYSIS_HOLD_MS = 60_000

/**
 * Footage analysis waits while `plan` is made and until a free draft is on the timeline, where applyDraft holds it
 * until the preview shows the draft. It goes on when the plan fails, is cancelled or waits for its cost to be accepted.
 */
async function applyIfFreeOnceDone(plan: Promise<DirectorState>): Promise<void> {
  const done = plan.then(applyIfFree)
  holdAnalysisUntil(done, PLAN_ANALYSIS_HOLD_MS)
  await done
}

const SEEDS_KEY = 'mv-studio.director.seeds.v1'
const SEEDS_KEPT = 50

function savedSeeds(): Record<string, number> {
  try {
    const seeds: unknown = JSON.parse(localStorage.getItem(SEEDS_KEY) ?? '{}')
    return seeds && typeof seeds === 'object' ? (seeds as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/**
 * The seed of the project's last plan. A new draft plans with it, so after a reload (which starts the Director over) the
 * same request plans the same version, and its prompts find the AI shots already made for it in Media instead of
 * paying again.
 */
export function lastSeed(projectId: Id): number | undefined {
  const seed = savedSeeds()[projectId]
  return Number.isInteger(seed) && seed >= 1 ? seed : undefined
}

/** Keeps the latest seeds of the last SEEDS_KEPT projects. */
export function rememberSeed(projectId: Id, seed: number): void {
  const seeds = savedSeeds()
  if (seeds[projectId] === seed) return
  delete seeds[projectId]
  seeds[projectId] = seed
  const ids = Object.keys(seeds)
  for (const id of ids.slice(0, Math.max(0, ids.length - SEEDS_KEPT))) delete seeds[id]
  try {
    localStorage.setItem(SEEDS_KEY, JSON.stringify(seeds))
  } catch {
    // Storage blocked or full: a new draft starts from the first version, as before.
  }
}

/** Plans a draft; one that costs nothing goes on the timeline right away. */
export async function draftVideo(request: DirectorRequest): Promise<void> {
  const projectId = editor.getProject().id
  const s = await directorSession()
  // The director loads on first use: the request was made for the project open before it loaded.
  if (!stillOpen(projectId)) return
  autoApply = true
  useDirector.setState({ clipsAtDraft: clipsNow() })
  const seed = request.seed ?? lastSeed(projectId)
  await applyIfFreeOnceDone(s.plan(seed === undefined ? request : { ...request, seed }))
}

/** Plans again with another seed: different clips, prompts and camera moves. */
export async function tryAnotherVersion(): Promise<void> {
  const s = await directorSession()
  autoApply = true
  useDirector.setState({ clipsAtDraft: clipsNow() })
  await applyIfFreeOnceDone(s.tryAnother())
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
  await applyIfFreeOnceDone(s.useLocalDraft())
}

/** Applies the plan: generates AI shots first unless skipped (the panel has asked about the cost). */
export async function applyDraft(options: { confirmSpend?: boolean; skipGeneration?: boolean } = {}) {
  const projectId = editor.getProject().id
  const s = await directorSession()
  try {
    // Loaded with the session already.
    const { openingFrame } = await import('../../director/index.ts')
    // Another project opened meanwhile, which reset the plan: there is nothing to apply.
    if (!stillOpen(projectId)) return
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
    // Straight after the dispatch, before the timeline's frame thumbnails of the draft's clips start decoding, and before
    // footage analysis decodes its next frame of the same files.
    holdAnalysisUntil(holdThumbnailsForDraft())
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

/**
 * What leaving the open project would lose of the Director's draft: AI shots made for a draft that isn't on the
 * timeline, or failed shots of one that is, waiting for Retry. Null when nothing would be lost.
 */
export function heldDraftOf(state: DirectorState): HeldDraft | null {
  if (state.status === 'applied')
    return state.failedShots > 0 ? { kind: 'failed', unit: state.unit, failed: state.failedShots } : null
  if ((state.status === 'ready' || state.status === 'error') && state.plan && state.generatedShots > 0) {
    // Shots still to make, the ones media made earlier would cover included: applying now skips generation.
    const missing = state.cost ? state.cost.count + state.cost.reused : 0
    return { kind: 'unapplied', unit: state.unit, made: state.generatedShots, missing }
  }
  return null
}

holdDrafts({
  held: () => heldDraftOf(useDirector.getState().state),
  apply: async () => {
    await applyDraft({ skipGeneration: true })
    return useDirector.getState().state.status === 'applied'
  },
})

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
