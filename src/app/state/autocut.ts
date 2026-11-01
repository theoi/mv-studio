import { create } from 'zustand'
import { BARS_NOTES, type Asset, type Id, type Project } from '../../model/index.ts'
import { jobs, type JobErrorCode, type JobHandle } from '../../shared/jobs.ts'
import type {
  AutoCutOn,
  AutoCutOptions,
  AutoCutPace,
  AutoCutResult,
  IndexingState,
} from '../../vision/index.ts'
import { isBlankClip, readClipTags, readSubjectTrack } from '../../vision/analysisData.ts'
import { shortFileName } from '../../shared/text.ts'
import { plural } from '../format.ts'
import {
  analyzeFootageAndWait,
  checkClipsForBlank,
  showingDownloads,
  useFootage,
  visionService,
} from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { visionDownloadBytes } from './models.ts'
import { editor, sectionAt, sectionsOf } from './project.ts'
import { barsState, ensureBars } from './songAnalysis.ts'
import type { Selection } from './ui.ts'

/*
 * Assist › Auto-cut on src/vision's autoCut. The panel's choices live here so they survive leaving the panel, and
 * each finished job's result (cuts, warnings, undo label) is kept by job id for the done state.
 */

export type AutoCutRange = 'all' | 'section'
/** "chosen" is every clip but the ones the user left out of the panel's list (`leftOut`). */
export type AutoCutClips = 'all' | 'selected' | 'chosen'
/** "mood" follows the Match clips to the mood switch (matched or shuffled); "story" keeps import order. */
export type AutoCutClipOrder = 'mood' | 'story'

/** Which clips the panel cuts. Saved with the project (`clipChoice`), unlike the other choices. */
export interface AutoCutClipChoice {
  clips: AutoCutClips
  /** Clips left out of "Choose clips". Clips imported later are in until the user leaves them out too. */
  leftOut: Id[]
  /** Clips the user ticked in "Choose clips". Clips that show nothing (`isBlankClip`) are out until they are here. */
  kept?: Id[]
}

export interface AutoCutChoices extends AutoCutClipChoice {
  pace: AutoCutPace
  followEnergy: boolean
  matchMood: boolean
  range: AutoCutRange
  /** More options: the grid lines cuts land on ('beats' follows the pace). */
  cutOn: AutoCutOn
  clipOrder: AutoCutClipOrder
}

export const DEFAULT_AUTOCUT_CHOICES: AutoCutChoices = {
  pace: 'bar',
  followEnergy: true,
  matchMood: true,
  range: 'all',
  clips: 'all',
  leftOut: [],
  cutOn: 'beats',
  clipOrder: 'mood',
}

/** Whether the cut matches clips to the song with footage analysis (not shuffled, not story order). */
export const matchesMood = (choices: Pick<AutoCutChoices, 'matchMood' | 'clipOrder'>) =>
  choices.matchMood && choices.clipOrder === 'mood'

type SessionChoices = Omit<AutoCutChoices, keyof AutoCutClipChoice>

export const useAutoCut = create<{ choices: SessionChoices; results: Record<string, AutoCutResult> }>(() => ({
  choices: DEFAULT_AUTOCUT_CHOICES,
  results: {},
}))

export function setAutoCutChoices(patch: Partial<SessionChoices>): void {
  useAutoCut.setState((s) => ({ choices: { ...s.choices, ...patch } }))
}

const CLIP_CHOICE = 'autocut.clips'

/** The project's saved clip choice: every clip until the user picks otherwise. */
export function clipChoice(project: Project): AutoCutClipChoice {
  const saved = project.extensions?.[CLIP_CHOICE]
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { clips: 'all', leftOut: [] }
  const clips = saved.clips === 'selected' || saved.clips === 'chosen' ? saved.clips : 'all'
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  const kept = ids(saved.kept)
  return { clips, leftOut: ids(saved.leftOut), ...(kept.length ? { kept } : {}) }
}

/**
 * Changes the clip choice saved with the project, so it survives a reload and another project opened in the tab
 * starts from its own. It is a setting of the panel, not an edit of the video, so it adds no undo step.
 */
export function setClipChoice(patch: Partial<AutoCutClipChoice>): void {
  const value = { ...clipChoice(editor.getProject()), ...patch }
  editor.dispatch({ type: 'project.setExtension', key: CLIP_CHOICE, value }, { history: 'skip' })
}

/** The clips and stills auto-cut can use: the imported and generated ones, in src/vision's autoCutPool order. */
export function autoCutAssets(project: Project) {
  return Object.values(project.assets)
    .filter(
      (a) =>
        (a.origin.type === 'import' || a.origin.type === 'generated') &&
        (a.kind === 'image' || (a.kind === 'video' && (a.duration ?? 0) > 0)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

export function autoCutClipCount(project: Project): number {
  return autoCutAssets(project).length
}

/** Whether footage analysis has indexed the asset for matching. */
function indexed(project: Project, assetId: Id): boolean {
  const data = project.analysis.visual[assetId]?.data
  return !!(data && typeof data === 'object' && !Array.isArray(data) && data.embedding)
}

const unanalyzed = (project: Project, assetIds?: readonly Id[]) => {
  const wanted = assetIds && new Set(assetIds)
  return autoCutAssets(project).filter((a) => (!wanted || wanted.has(a.id)) && !indexed(project, a.id))
}

/** Clips footage analysis has not indexed for matching yet; auto-cut picks them for variety only. */
export function unanalyzedClipCount(project: Project): number {
  return unanalyzed(project).length
}

/**
 * The clips not analyzed yet (of `assetIds` when given), split into those analysis will still pick up (`waiting`) and
 * those it failed to read (`unreadable`, in the order they failed), which only a retry of failed clips analyzes again.
 */
export function analysisBacklog(
  project: Project,
  indexing: IndexingState | null,
  assetIds?: readonly Id[],
): { waiting: number; unreadable: IndexingState['failed'] } {
  const left = unanalyzed(project, assetIds)
  const ids = new Set(left.map((a) => a.id))
  const unreadable = (indexing?.failed ?? []).filter((f) => ids.has(f.assetId))
  return { waiting: left.length - unreadable.length, unreadable }
}

const TRY_AGAIN = 'Try again in Match footage, then cut again to match the mood.'

/**
 * What stopped footage analysis, by its error's code, for the cut's note, with what the user can do about it (none
 * when `next` is empty, Try again in Match footage when it is left out).
 */
const ANALYSIS_STOPPED: Partial<Record<JobErrorCode, { why: string; next?: string }>> = {
  network: {
    why: 'couldn’t finish its download',
    next: 'Check your connection and try again in Match footage, then cut again to match the mood.',
  },
  'model-load': { why: 'couldn’t start' },
  'out-of-memory': { why: 'ran out of memory' },
  'storage-quota': {
    why: 'ran out of browser storage',
    next: 'Free space in Settings › Storage and try again in Match footage, then cut again to match the mood.',
  },
  unsupported: { why: 'can’t run in this browser', next: '' },
}

/**
 * The cut's note for clips it used without matching, when footage analysis says why they have no index: it stopped
 * with an error, was cancelled, or couldn’t read them. Undefined while they are only waiting for analysis.
 */
export function unanalyzedWarning(
  assetIds: readonly Id[],
  all: boolean,
  indexing: IndexingState | null,
): string | undefined {
  const n = assetIds.length
  if (!indexing || !n) return undefined
  const clips = all
    ? n === 1
      ? 'your clip was'
      : 'your clips were'
    : `${plural(n, 'clip')} ${n === 1 ? 'was' : 'were'}`
  if (indexing.status === 'error') {
    const { why, next = TRY_AGAIN } = (indexing.error && ANALYSIS_STOPPED[indexing.error.code]) ?? {
      why: 'stopped',
    }
    return `Footage analysis ${why}, so ${clips} picked for variety.${next ? ` ${next}` : ''}`
  }
  if (indexing.status === 'paused')
    return `Footage analysis was cancelled, so ${clips} picked for variety. Analyze your footage in Match footage, then cut again to match the mood.`
  const ids = new Set(assetIds)
  const failed = indexing.failed.filter((f) => ids.has(f.assetId))
  if (failed.length < n) return undefined
  const [first] = failed
  if (n === 1 && first)
    return `“${shortFileName(first.name)}” couldn’t be analyzed, so it was picked for variety.`
  return `${all ? 'Your clips' : plural(n, 'clip')} couldn’t be analyzed, so they were picked for variety.`
}

/** Bytes the footage tagger still has to download on this device to match clips (once), 0 when it is cached. */
export function matchingDownloadBytes(): Promise<number> {
  return visionDownloadBytes('tagger')
}

/** The section "Selected section" cuts: the selected one, else the one under the playhead. */
export function targetSection(project: Project, selection: Selection, playhead: number) {
  if (selection.type === 'section') return sectionsOf(project).find((s) => s.id === selection.id)
  return sectionAt(project, playhead)
}

/** The media of the selected video and image clips, each once, for "Selected clips". */
export function selectedAssets(project: Project, selection: Selection): { id: Id; name: string }[] {
  if (selection.type !== 'clip') return []
  const found = new Map<Id, string>()
  for (const id of selection.ids ?? [selection.id]) {
    const clip = project.clips[id]
    if (!clip || (clip.type !== 'video' && clip.type !== 'image')) continue
    const asset = project.assets[clip.assetId]
    if (asset && !found.has(asset.id)) found.set(asset.id, clip.name ?? asset.name)
  }
  return [...found].map(([id, name]) => ({ id, name }))
}

type TickedClips = Pick<AutoCutClipChoice, 'leftOut' | 'kept'>

/** Whether "Choose clips" ticks a clip: unless the user left it out, and one that shows nothing only once ticked. */
export function isChosen(project: Project, choice: TickedClips, id: Id): boolean {
  if (choice.leftOut.includes(id)) return false
  return !isBlankClip(project.analysis.visual[id]) || (choice.kept ?? []).includes(id)
}

/** The clip choice after the user ticks or unticks one clip in "Choose clips". */
export function tickClip(choice: TickedClips, id: Id, on: boolean): Required<TickedClips> {
  const leftOut = choice.leftOut.filter((x) => x !== id)
  const kept = (choice.kept ?? []).filter((x) => x !== id)
  return on ? { leftOut, kept: [...kept, id] } : { leftOut: [...leftOut, id], kept }
}

/** The clips "Choose clips" cuts: every clip auto-cut can use but the ones left out or not ticked (`isChosen`). */
export function chosenAssetIds(project: Project, choice: TickedClips): Id[] {
  return autoCutAssets(project)
    .filter((a) => isChosen(project, choice, a.id))
    .map((a) => a.id)
}

/** The clips a cut with these choices uses, or undefined for every clip. */
export function usedAssetIds(
  choices: AutoCutClipChoice,
  project: Project,
  selection: Selection,
): Id[] | undefined {
  if (choices.clips === 'selected') {
    const selected = selectedAssets(project, selection)
    return selected.length ? selected.map((a) => a.id) : undefined
  }
  if (choices.clips !== 'chosen') return undefined
  const chosen = chosenAssetIds(project, choices)
  // A cut of every clip leaves out the ones that show nothing, so it matches a choice of exactly the others.
  const showsSomething = autoCutAssets(project).filter((a) => !isBlankClip(project.analysis.visual[a.id]))
  return chosen.length === showsSomething.length && showsSomething.every((a) => chosen.includes(a.id))
    ? undefined
    : chosen
}

/** autoCut options for the panel's choices, against the project and selection as they are now. */
export function autoCutOptions(
  choices: AutoCutChoices,
  project: Project,
  selection: Selection,
  playhead: number,
): Omit<AutoCutOptions, 'seed'> {
  const section = choices.range === 'section' ? targetSection(project, selection, playhead) : undefined
  const assetIds = usedAssetIds(choices, project, selection)
  return {
    pace: choices.pace,
    followEnergy: choices.followEnergy,
    cutOn: choices.cutOn,
    order: choices.clipOrder === 'story' ? 'chronological' : choices.matchMood ? 'matched' : 'shuffled',
    ...(section ? { range: { start: section.start, end: section.end } } : {}),
    ...(assetIds ? { assetIds } : {}),
  }
}

const STAGE_MESSAGES: Record<string, string> = {
  bars: BARS_NOTES.finding,
  checking: 'Checking your clips…',
  planning: 'Finding the cuts in the song',
  matching: 'Choosing a clip for each shot',
}

const analyzingMessage = (done: number, total: number) =>
  `Analyzing your footage… ${done} of ${plural(total, 'clip')}`

/** Share of the job's progress spent finding bars, when they are not found yet. */
const BARS_SHARE = 0.4
/** Share of the rest of the job's progress spent waiting for the clips' blank check, when it is still running. */
const CHECK_SHARE = 0.1

/*
 * Time left in a cut, measured on a 4-core computer without a capable GPU on 12 phone and camera clips (1080p to 4K,
 * 24 to 60 fps) and a 3 min song. Decoding every frame dominates footage analysis, so a clip's cost grows with its
 * length, frame size and frame rate. The estimate then follows how long this computer took for the clips analyzed so
 * far against their prediction, so a slower or faster computer gets a longer or shorter one.
 */
const ANALYSIS_SECONDS_PER_SECOND = 0.55
const ANALYSIS_SECONDS_PER_MEGAPIXEL_SECOND = 0.11
const STILL_ANALYSIS_SECONDS = 1
/** Finding the bars, per second of song, model download included. */
const BARS_SECONDS_PER_SECOND = 0.15
/** Finding the cuts and placing them once the clips are analyzed and the bars found. */
const PLAN_SECONDS = 3
/** How many predicted seconds of analysis the prediction's own pace counts for against the measured one. */
const PACE_PRIOR_SECONDS = 30
/** Share of a clip's analysis spent matching; finding its subjects takes the rest, and its tags next to nothing. */
const MATCHING_SHARE = 0.5
type IndexStep = NonNullable<IndexingState['current']>['step']
const STEP_SHARE: Record<IndexStep, number> = {
  matching: MATCHING_SHARE,
  tags: 0,
  subjects: 1 - MATCHING_SHARE,
}

/** Predicted seconds footage analysis takes for a clip or still, both of its steps (matching, then subjects). */
export function clipAnalysisSeconds(asset: Asset): number {
  if (asset.kind !== 'video') return STILL_ANALYSIS_SECONDS
  const megapixels = ((asset.width ?? 1920) * (asset.height ?? 1080)) / 1e6
  const rate = (asset.frameRate ?? 30) / 30
  return (
    (asset.duration ?? 0) *
    (ANALYSIS_SECONDS_PER_SECOND + ANALYSIS_SECONDS_PER_MEGAPIXEL_SECOND * megapixels * rate)
  )
}

/**
 * How many times longer than predicted this computer takes for footage analysis, from analysis predicted to take
 * `predictedDone` seconds that took `elapsed`. The prediction counts too, so one short clip can't set the pace alone.
 */
export function analysisPace(predictedDone: number, elapsed: number): number {
  const pace = (elapsed + PACE_PRIOR_SECONDS) / (predictedDone + PACE_PRIOR_SECONDS)
  return Math.min(4, Math.max(0.5, pace))
}

/** The analysis steps a clip still needs, in the order footage analysis runs them (as its indexer plans them). */
function stepsLeft(project: Project, assetId: Id): IndexStep[] {
  const visual = project.analysis.visual[assetId]
  const steps: IndexStep[] = []
  if (!indexed(project, assetId)) steps.push('matching')
  if (!readClipTags(visual)) steps.push('tags')
  if (!readSubjectTrack(visual)) steps.push('subjects')
  return steps
}

export interface QueuedClip {
  asset: Asset
  /** The steps footage analysis runs for it, as planned when the cut started. */
  steps: IndexStep[]
}

/**
 * The clips footage analysis goes through until each of `assetIds` is matched. It analyzes the oldest first and runs
 * every step a clip still needs before the next, so an older clip waits in front of the cut's too: one left out of
 * the cut, or one matched earlier whose subjects were never found (analysis cancelled, or a project made before).
 */
export function analysisQueue(project: Project, assetIds: readonly Id[]): QueuedClip[] {
  const ids = new Set(assetIds)
  const queue = autoCutAssets(project)
    .map((asset) => ({ asset, steps: stepsLeft(project, asset.id) }))
    .filter((c) => c.steps.length > 0)
    .sort(
      (a, b) => a.asset.createdAt.localeCompare(b.asset.createdAt) || a.asset.id.localeCompare(b.asset.id),
    )
  return queue.slice(0, queue.findLastIndex((c) => ids.has(c.asset.id)) + 1)
}

/**
 * Predicted seconds of the analysis of `queue` (from `analysisQueue`) done so far, and still to wait for: each
 * clip's steps still missing from the project, less how far the clip being analyzed is into its step. The last
 * clip counts only its matching, as the cut goes on once it is matched.
 */
export function analysisProgress(
  project: Project,
  queue: readonly QueuedClip[],
  state?: IndexingState,
): { done: number; left: number } {
  const failed = new Set(state?.failed.map((f) => f.assetId))
  let total = 0
  let left = 0
  queue.forEach(({ asset, steps }, i) => {
    const cost = clipAnalysisSeconds(asset)
    const counted = i === queue.length - 1 ? steps.filter((s) => s === 'matching') : steps
    const work = (list: readonly IndexStep[]) => cost * list.reduce((sum, s) => sum + STEP_SHARE[s], 0)
    total += work(counted)
    if (failed.has(asset.id)) return
    const missing = stepsLeft(project, asset.id)
    let remaining = work(counted.filter((s) => missing.includes(s)))
    const current = state?.current
    if (current?.assetId === asset.id && counted.includes(current.step)) {
      // The indexer spreads a clip's fraction evenly over its steps.
      const within = current.fraction * steps.length - steps.indexOf(current.step)
      remaining -= cost * STEP_SHARE[current.step] * Math.min(1, Math.max(0, within))
    }
    left += Math.max(0, remaining)
  })
  return { done: total - left, left }
}

/** Seconds left in a cut, from the predicted analysis and bar finding still to do and the measured pace. */
export function cutSecondsLeft(analysisLeft: number, barsLeft: number, pace: number): number {
  return Math.round((analysisLeft + barsLeft) * pace + PLAN_SECONDS)
}
let runs = 0

/**
 * Runs auto-cut as a job. Every run takes the next seed, so cutting again with the same choices gives a different
 * cut; either way only auto-cut clips nobody touched are replaced.
 *
 * With `analyzeFirst`, a cut that matches clips first analyzes the ones not analyzed yet (also where background
 * analysis is off) and waits for them, as the job's `analyzing` stage, so every clip analysis can read is matched.
 * Cancelling the job in that stage also stops the analysis if the job started it. When the analysis stops with an
 * error, is cancelled elsewhere or can’t read a clip, the cut picks those clips for variety and its note says why.
 */
export function startAutoCut(
  options: Omit<AutoCutOptions, 'seed'>,
  { analyzeFirst = false }: { analyzeFirst?: boolean } = {},
): JobHandle<AutoCutResult> | undefined {
  if (isRunning(JOB_KINDS.autocut)) return undefined
  const seed = ++runs
  let id = ''
  const handle = jobs.run({
    kind: JOB_KINDS.autocut,
    title: 'Cutting to the beat',
    run: showingDownloads(['tagger', 'cutout'], async (ctx) => {
      const matched = (options.order ?? 'matched') === 'matched'
      const wanted = options.assetIds && new Set(options.assetIds)
      const project = editor.getProject()
      const waiting = unanalyzed(project)
        .filter((a) => !wanted || wanted.has(a.id))
        .map((a) => a.id)
      const analyze = analyzeFirst && matched && waiting.length > 0
      // Without the analysis, the fast blank check still finds the clips that show nothing, so the cut can leave them
      // out. It runs while the bars are found.
      let checkFraction = 0
      let reportCheck: ((fraction: number) => void) | undefined
      const checked = analyze
        ? undefined
        : checkClipsForBlank({
            ...(options.assetIds ? { assetIds: options.assetIds } : {}),
            signal: ctx.signal,
            progress: (f) => {
              checkFraction = f
              reportCheck?.(f)
            },
          })
      let checking = !!checked
      checked?.then(
        () => (checking = false),
        () => (checking = false),
      )
      // The analyzing stage takes the first half of the bar. Cuts phrase on bars, so a song whose bars are still being
      // found waits for them next; the cut takes the rest.
      const analyzed = analyze ? 0.5 : 0
      const findBars = barsState().status !== 'ready'
      const share = findBars ? BARS_SHARE * (1 - analyzed) : 0
      let from = analyzed + share
      const scale = (f: number) => from + f * (1 - from)
      const song = project.songAssetId ? project.assets[project.songAssetId] : undefined
      const barsSeconds = findBars ? BARS_SECONDS_PER_SECOND * (song?.duration ?? 0) : 0
      // Only a cut that waits says how long. With the clips analyzed and the bars found, it is done at once.
      const timed = analyze || findBars
      let pace = 1
      if (analyze) {
        const queue = analysisQueue(project, waiting)
        let first: Id | undefined
        let from: { at: number; done: number } | undefined
        const report = (s?: IndexingState) => {
          const { done, left } = analysisProgress(editor.getProject(), queue, s)
          // The first clip analyzed also waits for the models to load, so the pace counts from the next one.
          if (s?.current) {
            first ??= s.current.assetId
            if (!from && s.current.assetId !== first) from = { at: performance.now(), done }
          }
          pace = from ? analysisPace(done - from.done, (performance.now() - from.at) / 1000) : 1
          // Song analysis may find the bars meanwhile.
          const barsLeft = barsState().status === 'ready' ? 0 : barsSeconds
          const fraction = s?.total ? Math.min(1, (s.done + (s.current?.fraction ?? 0)) / s.total) : 0
          ctx.progress({
            fraction: fraction * analyzed,
            stage: 'analyzing',
            message: analyzingMessage(s?.done ?? 0, s?.total || waiting.length),
            etaSeconds: cutSecondsLeft(left, barsLeft, pace),
          })
        }
        report()
        await analyzeFootageAndWait(waiting, {
          signal: ctx.signal,
          onProgress: (s) => {
            if (s.status === 'indexing' && s.total) report(s)
          },
        })
      }
      const barsStarted = performance.now()
      const bars = await ensureBars({
        signal: ctx.signal,
        progress: (f) => {
          const left = Math.max(
            barsSeconds * 0.1,
            barsSeconds - (performance.now() - barsStarted) / 1000 / pace,
          )
          ctx.progress({
            fraction: analyzed + f * share,
            stage: 'bars',
            message: STAGE_MESSAGES.bars,
            etaSeconds: cutSecondsLeft(0, left, pace),
          })
        },
      })
      // A check with nothing left to do settles within a few microtasks: only one still running gets a word.
      if (checking)
        await Promise.race([checked?.catch(() => undefined), new Promise((r) => setTimeout(r, 0))])
      if (checking) {
        const start = from
        from += CHECK_SHARE * (1 - from)
        reportCheck = (f) =>
          ctx.progress({
            fraction: start + f * (from - start),
            stage: 'checking',
            message: STAGE_MESSAGES.checking,
            etaSeconds: undefined,
          })
        reportCheck(checkFraction)
      }
      // A check that fails leaves its clips in the cut, as before the check.
      await checked?.catch(() => ctx.throwIfCancelled())
      reportCheck = undefined
      ctx.progress({
        fraction: scale(0),
        stage: 'planning',
        message: STAGE_MESSAGES.planning,
        etaSeconds: timed ? cutSecondsLeft(0, 0, pace) : undefined,
      })
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      const cut = await v.autoCut(
        {
          editor,
          matcher: vision.matcher,
          unanalyzedWarning: (ids, all) => unanalyzedWarning(ids, all, useFootage.getState().indexing),
        },
        { ...options, seed },
        {
          signal: ctx.signal,
          onProgress: (p) =>
            ctx.progress({
              ...p,
              ...(p.fraction === undefined ? {} : { fraction: scale(p.fraction) }),
              message: STAGE_MESSAGES[p.stage ?? ''] ?? p.message,
            }),
        },
      )
      const beatsOnly = !bars && barsState().status === 'unavailable'
      const result = beatsOnly ? { ...cut, warnings: [...cut.warnings, BARS_NOTES.beatsOnly] } : cut
      useAutoCut.setState((s) => ({ results: { ...s.results, [id]: result } }))
      return result
    }),
  })
  id = handle.id
  return handle
}

/** Undoes an auto-cut while it is still the latest edit. Returns whether it did. */
export function undoAutoCut(result: AutoCutResult | undefined): boolean {
  if (!result || editor.undoLabel() !== result.label) return false
  return editor.undo()
}
