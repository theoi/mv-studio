import { create } from 'zustand'
import { BARS_NOTES, type Id, type Project } from '../../model/index.ts'
import { jobs, type JobHandle } from '../../shared/jobs.ts'
import { modelCache } from '../../shared/models.ts'
import type {
  AutoCutOn,
  AutoCutOptions,
  AutoCutPace,
  AutoCutResult,
  IndexingState,
} from '../../vision/index.ts'
import { VISION_MODELS } from '../../vision/runtime/models.ts'
import { plural } from '../format.ts'
import { analyzeFootageAndWait, visionService } from './footage.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { editor, sectionAt, sectionsOf } from './project.ts'
import { barsState, ensureBars } from './songAnalysis.ts'
import type { Selection } from './ui.ts'

/*
 * Assist › Auto-cut on src/vision's autoCut. The panel's choices live here so they survive leaving the panel, and
 * each finished job's result (cuts, warnings, undo label) is kept by job id for the done state.
 */

export type AutoCutRange = 'all' | 'section'
export type AutoCutClips = 'all' | 'selected'
/** "mood" follows the Match clips to the mood switch (matched or shuffled); "story" keeps import order. */
export type AutoCutClipOrder = 'mood' | 'story'

export interface AutoCutChoices {
  pace: AutoCutPace
  followEnergy: boolean
  matchMood: boolean
  range: AutoCutRange
  clips: AutoCutClips
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
  cutOn: 'beats',
  clipOrder: 'mood',
}

/** Whether the cut matches clips to the song with footage analysis (not shuffled, not story order). */
export const matchesMood = (choices: AutoCutChoices) => choices.matchMood && choices.clipOrder === 'mood'

export const useAutoCut = create<{ choices: AutoCutChoices; results: Record<string, AutoCutResult> }>(() => ({
  choices: DEFAULT_AUTOCUT_CHOICES,
  results: {},
}))

export function setAutoCutChoices(patch: Partial<AutoCutChoices>): void {
  useAutoCut.setState((s) => ({ choices: { ...s.choices, ...patch } }))
}

/** The clips and stills auto-cut can use: the imported and generated ones, as src/vision's autoCutPool. */
function poolAssets(project: Project) {
  return Object.values(project.assets).filter(
    (a) =>
      (a.origin.type === 'import' || a.origin.type === 'generated') &&
      (a.kind === 'image' || (a.kind === 'video' && (a.duration ?? 0) > 0)),
  )
}

export function autoCutClipCount(project: Project): number {
  return poolAssets(project).length
}

const unanalyzed = (project: Project) =>
  poolAssets(project).filter((a) => {
    const data = project.analysis.visual[a.id]?.data
    return !(data && typeof data === 'object' && !Array.isArray(data) && data.embedding)
  })

/** Clips footage analysis has not indexed for matching yet; auto-cut picks them for variety only. */
export function unanalyzedClipCount(project: Project): number {
  return unanalyzed(project).length
}

/**
 * The clips not analyzed yet, split into those analysis will still pick up (`waiting`) and those it failed to read
 * (`unreadable`, in the order they failed), which only a retry of failed clips analyzes again.
 */
export function analysisBacklog(
  project: Project,
  indexing: IndexingState | null,
): { waiting: number; unreadable: IndexingState['failed'] } {
  const left = unanalyzed(project)
  const ids = new Set(left.map((a) => a.id))
  const unreadable = (indexing?.failed ?? []).filter((f) => ids.has(f.assetId))
  return { waiting: left.length - unreadable.length, unreadable }
}

/** Bytes footage analysis still has to download to match clips (the matching model, once), 0 when cached. */
export async function matchingDownloadBytes(): Promise<number> {
  const files = Object.values(VISION_MODELS.clipB32.files)
  const cached = await Promise.all(files.map((f) => modelCache.has(f.url).catch(() => false)))
  return files.reduce((sum, f, i) => sum + (cached[i] ? 0 : (f.bytes ?? 0)), 0)
}

/** The section "Selected section" cuts: the selected one, else the one under the playhead. */
export function targetSection(project: Project, selection: Selection, playhead: number) {
  if (selection.type === 'section') return sectionsOf(project).find((s) => s.id === selection.id)
  return sectionAt(project, playhead)
}

/** The asset of the selected video or image clip, for "Selected clips". */
export function selectedAsset(project: Project, selection: Selection): { id: Id; name: string } | undefined {
  if (selection.type !== 'clip') return undefined
  const clip = project.clips[selection.id]
  if (!clip || (clip.type !== 'video' && clip.type !== 'image')) return undefined
  const asset = project.assets[clip.assetId]
  return asset ? { id: asset.id, name: clip.name ?? asset.name } : undefined
}

/** autoCut options for the panel's choices, against the project and selection as they are now. */
export function autoCutOptions(
  choices: AutoCutChoices,
  project: Project,
  selection: Selection,
  playhead: number,
): Omit<AutoCutOptions, 'seed'> {
  const section = choices.range === 'section' ? targetSection(project, selection, playhead) : undefined
  const asset = choices.clips === 'selected' ? selectedAsset(project, selection) : undefined
  return {
    pace: choices.pace,
    followEnergy: choices.followEnergy,
    cutOn: choices.cutOn,
    order: choices.clipOrder === 'story' ? 'chronological' : choices.matchMood ? 'matched' : 'shuffled',
    ...(section ? { range: { start: section.start, end: section.end } } : {}),
    ...(asset ? { assetIds: [asset.id] } : {}),
  }
}

const STAGE_MESSAGES: Record<string, string> = {
  bars: BARS_NOTES.finding,
  planning: 'Finding the cuts in the song',
  matching: 'Choosing a clip for each shot',
}

const analyzingMessage = (done: number, total: number) =>
  `Analyzing your footage… ${done} of ${plural(total, 'clip')}`

/** Share of the job's progress spent finding bars, when they are not found yet. */
const BARS_SHARE = 0.4

let runs = 0

/**
 * Runs auto-cut as a job. Every run takes the next seed, so cutting again with the same choices gives a different
 * cut; either way only auto-cut clips nobody touched are replaced.
 *
 * With `analyzeFirst`, a cut that matches clips first analyzes the ones not analyzed yet (also where background
 * analysis is off) and waits for them, as the job's `analyzing` stage, so every clip analysis can read is matched.
 * Cancelling the job in that stage also stops the analysis if the job started it.
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
    run: async (ctx) => {
      const matched = (options.order ?? 'matched') === 'matched'
      const wanted = options.assetIds && new Set(options.assetIds)
      const waiting = unanalyzed(editor.getProject())
        .filter((a) => !wanted || wanted.has(a.id))
        .map((a) => a.id)
      const analyze = analyzeFirst && matched && waiting.length > 0
      // The analyzing stage takes the first half of the bar. Cuts phrase on bars, so a song whose bars are still being
      // found waits for them next; the cut takes the rest.
      const analyzed = analyze ? 0.5 : 0
      const share = barsState().status === 'ready' ? 0 : BARS_SHARE * (1 - analyzed)
      const scale = (f: number) => analyzed + share + f * (1 - analyzed - share)
      if (analyze) {
        ctx.progress({ fraction: 0, stage: 'analyzing', message: analyzingMessage(0, waiting.length) })
        await analyzeFootageAndWait(waiting, {
          signal: ctx.signal,
          onProgress: (s) => {
            if (s.status !== 'indexing' || !s.total) return
            const fraction = Math.min(1, (s.done + (s.current?.fraction ?? 0)) / s.total)
            ctx.progress({
              fraction: fraction * analyzed,
              stage: 'analyzing',
              message: analyzingMessage(s.done, s.total),
            })
          },
        })
      }
      const bars = await ensureBars({
        signal: ctx.signal,
        progress: (f) =>
          ctx.progress({ fraction: analyzed + f * share, stage: 'bars', message: STAGE_MESSAGES.bars }),
      })
      ctx.progress({ fraction: scale(0), stage: 'planning', message: STAGE_MESSAGES.planning })
      const [v, vision] = await Promise.all([import('../../vision/index.ts'), visionService()])
      const cut = await v.autoCut(
        { editor, matcher: vision.matcher },
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
    },
  })
  id = handle.id
  return handle
}

/** Undoes an auto-cut while it is still the latest edit. Returns whether it did. */
export function undoAutoCut(result: AutoCutResult | undefined): boolean {
  if (!result || editor.undoLabel() !== result.label) return false
  return editor.undo()
}
