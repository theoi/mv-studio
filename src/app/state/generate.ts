import { produce } from 'immer'
import { useSyncExternalStore } from 'react'
import { DEFAULT_FAL_MODELS, FAL_MODELS, snapDuration, type FalModel } from '../../cloud/fal/catalog.ts'
import { generateKeepingPaid, storeGeneratedMedia } from '../../cloud/media.ts'
import { formatEstimate, needsSpendConfirmation, roundUsd } from '../../cloud/pricing.ts'
import type { GenerationRequest, GenerationTask } from '../../cloud/types.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import {
  applyCommand,
  type Asset,
  type EditCommand,
  type ImageClip,
  type Project,
} from '../../model/index.ts'
import { jobs, type JobContext, type JobProgress } from '../../shared/jobs.ts'
import { formatTime, plural } from '../format.ts'
import { gapAt } from './clipDrag.ts'
import { cloudServices, cloudSettings, spendLedger } from './cloud.ts'
import { assetPlacement } from './importer.ts'
import { JOB_KINDS } from './jobs.ts'
import { appMedia } from './media.ts'
import { dispatch, editor } from './project.ts'
import { showClips } from './reveal.ts'
import { beatGridOf } from '../../vj/quantize.ts'
import { get, openAssist, set, toast } from './ui.ts'

/*
 * Assist › Generate: AI images and video clips with the user's fal.ai key. The form is kept here so a result or an
 * error returns to the same settings. Each run is one job; its results are stored as project media and placed on the
 * timeline at the playhead as one undo step. A Cancel, or a failure part-way, keeps what fal.ai already made (and
 * billed) in Media only.
 */

export type GenerateKind = 'image' | 'video'

/** Where results land instead of the playhead: a gap picked on the timeline, or over the image being animated. */
export interface GenerateTarget {
  start: number
  /** The track to put the result on while it is free there. */
  trackId?: string
  /** The end of the gap: results are trimmed to fit it. */
  end?: number
  /** "at 0:58 on Overlay, in the gap up to 1:04" */
  where: string
}

export interface GenerateForm {
  kind: GenerateKind
  prompt: string
  /** Image asset to animate; null makes the video from the prompt alone. */
  startImageId: string | null
  /** The model picked for each task, when the user changed it. */
  models: Partial<Record<GenerationTask, string>>
  /** Video length in seconds, snapped to what the model supports. */
  duration: number
  /** Images per run. */
  count: number
  /** Null puts results at the playhead. */
  target: GenerateTarget | null
}

const DEFAULT_FORM: GenerateForm = {
  kind: 'video',
  prompt: '',
  startImageId: null,
  models: {},
  duration: 5,
  count: 1,
  target: null,
}

let form = DEFAULT_FORM
const formListeners = new Set<() => void>()

export function generateForm(): GenerateForm {
  return form
}

export function setGenerateForm(patch: Partial<GenerateForm>): void {
  form = { ...form, ...patch }
  for (const l of formListeners) l()
}

const subscribeForm = (listener: () => void) => {
  formListeners.add(listener)
  return () => formListeners.delete(listener)
}

export function useGenerateForm(): GenerateForm {
  return useSyncExternalStore(subscribeForm, generateForm)
}

export const IMAGE_COUNTS = [1, 2, 4]

export function taskOf(f: GenerateForm): GenerationTask {
  if (f.kind === 'image') return 'text-to-image'
  return f.startImageId ? 'image-to-video' : 'text-to-video'
}

/** The curated models for a task, draft (fast, inexpensive) first. */
export function modelsFor(task: GenerationTask): FalModel[] {
  return FAL_MODELS.filter((m) => m.task === task).sort(
    (a, b) => Number(a.tier === 'quality') - Number(b.tier === 'quality'),
  )
}

export function modelOf(f: GenerateForm): FalModel {
  const task = taskOf(f)
  const list = modelsFor(task)
  const chosen = list.find((m) => m.id === f.models[task])
  return chosen ?? list.find((m) => m.id === DEFAULT_FAL_MODELS[task].draft) ?? (list[0] as FalModel)
}

/** Lengths offered for a video model: its own list, or a few common ones within its range. */
export function lengthsFor(model: FalModel): number[] {
  const d = model.durations
  if (!d) return [model.defaultDuration ?? 5]
  if (Array.isArray(d)) return d
  return [3, 5, 8, 10, 15].filter((s) => s >= d.min && s <= d.max)
}

export function durationOf(f: GenerateForm, model: FalModel): number {
  return snapDuration(model, f.duration)
}

/** Images the Generate panel can animate: the project's image assets. */
export function startImages(project: Project): Asset[] {
  return Object.values(project.assets).filter((a) => a.kind === 'image')
}

export function requestOf(f: GenerateForm, project: Project): GenerationRequest {
  const model = modelOf(f)
  return {
    task: model.task,
    modelId: model.id,
    prompt: f.prompt.trim(),
    aspect: project.settings.aspect,
    ...(model.output === 'video' ? { duration: durationOf(f, model) } : {}),
  }
}

export interface GenerateEstimate {
  usd: number
  /** "5 s × $0.04/s at 768p", with "× 4" for several images. */
  breakdown: string
  approximate: boolean
}

export function estimateOf(f: GenerateForm, project: Project): GenerateEstimate {
  const model = modelOf(f)
  const one = model.estimate(requestOf(f, project))
  const count = model.output === 'image' ? f.count : 1
  return {
    usd: roundUsd(one.usd * count),
    breakdown: count > 1 ? `${one.breakdown} × ${count}` : one.breakdown,
    approximate: one.approximate,
  }
}

/** Why the user must confirm before spending `usd`, or null when no confirmation is needed. */
export function spendCheck(usd: number): { monthTotal: number; reminderUsd: number } | null {
  const settings = cloudSettings.get()
  const crosses = spendLedger.crossesReminder(usd, settings.monthlyReminderUsd)
  if (!needsSpendConfirmation(usd, settings) && !crosses) return null
  return { monthTotal: spendLedger.monthTotal(), reminderUsd: crosses ? settings.monthlyReminderUsd : 0 }
}

/**
 * Commands that add the assets to the project and put them on the timeline one after another from `start`, each on
 * the first free track of its kind, or in the target's gap (trimmed to fit) while there is room in it.
 */
export function placementCommands(
  project: Project,
  assets: Asset[],
  start: number,
  target?: Pick<GenerateTarget, 'trackId' | 'end'>,
): EditCommand[] {
  const commands: EditCommand[] = []
  let working = project
  let at = start
  const apply = (list: EditCommand[]) => {
    working = produce(working, (draft) => {
      for (const c of list) applyCommand(draft, c)
    })
    commands.push(...list)
  }
  for (const asset of assets) {
    apply([{ type: 'asset.add', asset }])
    const room = target?.end !== undefined ? target.end - at : 0
    const placed = assetPlacement(
      working,
      asset,
      room > 0.25 ? { start: at, trackId: target?.trackId, maxDuration: room } : { start: at },
    )
    if (!placed) continue
    apply(placed.commands)
    at += placed.clip.duration
  }
  return commands
}

export interface GenerateOutcome {
  label: string
  assets: Asset[]
  start: number
  usd: number
  /** The clips it put on the timeline, for Show. */
  clipIds: string[]
  /** After a Cancel or a failure, what went to Media only: "2 images made so far are kept in Media." */
  kept?: string
}

const outcomes = new Map<string, GenerateOutcome>()
const runs = new Map<string, { task: GenerationTask; start: number }>()
let cancelNotice = ''

/** What a running Generate job is making and where it will land. */
export function generateRun(jobId: string | undefined): { task: GenerationTask; start: number } | undefined {
  return jobId ? runs.get(jobId) : undefined
}

/** The provider's note about cancelling paid requests (loaded with the provider, before any job runs). */
export function generateCancelNotice(): string {
  return cancelNotice
}

/** What a finished Generate job added, for its done view. */
export function generateOutcome(jobId: string | undefined): GenerateOutcome | undefined {
  return jobId ? outcomes.get(jobId) : undefined
}

/** Removes a result again when it is still the last edit. */
export function undoOutcome(outcome: GenerateOutcome): boolean {
  if (editor.undoLabel() !== outcome.label) return false
  return editor.undo()
}

/**
 * Maps one request's progress into its share of the job, and keeps the time left only while generating. After a
 * Cancel the job's line keeps saying it is stopping.
 */
function share(
  ctx: JobContext,
  from: number,
  to: number,
  prefix: string,
  onDownload: () => void,
): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: (p: JobProgress) => {
      if (p.stage === 'download') onDownload()
      if (ctx.signal.aborted) return
      ctx.progress({
        ...p,
        ...(p.fraction !== undefined ? { fraction: from + (to - from) * p.fraction } : {}),
        ...(p.message ? { message: `${prefix}${p.message}` } : {}),
        etaSeconds: p.stage === 'generate' ? p.etaSeconds : undefined,
      })
    },
  }
}

/**
 * Storing reports its own stages and fractions; the job shows one "saving" step instead. A Cancel doesn't stop it,
 * since the result is already paid for, and the job's line keeps saying it is stopping.
 */
function saving(ctx: JobContext, fraction: number, prefix: string): JobContext {
  return {
    signal: new AbortController().signal,
    throwIfCancelled: () => undefined,
    progress: () => {
      if (!ctx.signal.aborted)
        ctx.progress({ stage: 'store', fraction, message: `${prefix}Saving to your media library` })
    },
  }
}

/**
 * After a Cancel or a failure part-way, what fal.ai already made goes into Media (not the timeline) as one undo step.
 * `single` is a run that asked for one result.
 */
function keepInMedia(
  assets: Asset[],
  run: { label: string; unit: string; start: number; usd: number; single: boolean; failed: boolean },
): GenerateOutcome | undefined {
  if (assets.length === 0) return undefined
  const commands: EditCommand[] = assets.map((asset) => ({ type: 'asset.add', asset }))
  if (!dispatch(commands, { label: run.label })) return undefined
  // A no-break space keeps the count on the same line as its noun ("2 images").
  const kept = run.single
    ? `The ${run.unit} is kept in Media.`
    : `${plural(assets.length, run.unit).replace(' ', '\u00a0')} made so far ${assets.length === 1 ? 'is' : 'are'} kept in Media.`
  const outcome: GenerateOutcome = {
    label: run.label,
    assets,
    start: run.start,
    usd: run.usd,
    clipIds: [],
    kept,
  }
  toast(`Generation ${run.failed ? 'failed' : 'stopped'}. ${kept}`, {
    label: 'Undo',
    run: () => undoOutcome(outcome),
  })
  return outcome
}

/**
 * Starts a generation with the current form, placing the result at `at` (default: the playhead). Asks nothing: the
 * caller has already confirmed the cost.
 */
export async function startGenerate(at?: number): Promise<void> {
  const f = form
  const project = editor.getProject()
  const [services, fal] = await Promise.all([cloudServices(), import('../../cloud/fal/provider.ts')])
  cancelNotice = fal.FAL_CANCEL_NOTICE
  const provider = services.generation()
  if (!provider) {
    set({ dialog: 'settings', settingsPage: 'ai' })
    return
  }
  const request = requestOf(f, project)
  const model = modelOf(f)
  const count = model.output === 'image' ? f.count : 1
  const estimate = estimateOf(f, project)
  const target = at === undefined ? f.target : null
  const start = at ?? target?.start ?? get().playhead
  const imageId = request.task === 'image-to-video' ? f.startImageId : null
  const what = model.output === 'video' ? 'a video' : count > 1 ? `${count} images` : 'an image'
  const label =
    model.output === 'video' ? 'Generate video' : count > 1 ? `Generate ${count} images` : 'Generate image'
  let jobId = ''
  const handle = jobs.run({
    kind: JOB_KINDS.generate,
    title: `Generating ${what} · ${formatEstimate(estimate)}`,
    run: async (ctx) => {
      const image = imageId ? editor.getProject().assets[imageId] : undefined
      const blob = image ? await appMedia.getFile(image) : undefined
      ctx.throwIfCancelled()
      const assets: Asset[] = []
      let placed: string[]
      let usd = 0
      let downloading = false
      // A result fal.ai already billed still downloads for a while after a Cancel: say the Cancel was received.
      const stopping = () => {
        if (downloading) ctx.progress({ stage: 'stopping', message: 'Stopping…', etaSeconds: undefined })
      }
      ctx.signal.addEventListener('abort', stopping, { once: true })
      try {
        for (let i = 0; i < count && !ctx.signal.aborted; i++) {
          const prefix = count > 1 ? `Image ${i + 1} of ${count} · ` : ''
          const from = i / count
          const to = (i + 1) / count
          const result = await generateKeepingPaid(
            provider,
            { ...request, ...(blob ? { image: blob } : {}) },
            share(ctx, from, from + (to - from) * 0.96, prefix, () => (downloading = true)),
            { onBilled: (billed) => (usd += billed) },
          )
          downloading = false
          assets.push(
            ...(await storeGeneratedMedia(
              result,
              mediaStore,
              { prompt: request.prompt },
              saving(ctx, from + (to - from) * 0.98, prefix),
            )),
          )
        }
        ctx.throwIfCancelled()
        // Placed against the project as it is now, where it was meant to go when the user pressed Generate.
        const placement = placementCommands(editor.getProject(), assets, start, target ?? undefined)
        if (!dispatch(placement, { label })) throw new Error('The result could not be added to the project.')
        placed = placement.flatMap((c) => (c.type === 'clip.add' ? [c.clip.id] : []))
        // The next run goes to the playhead again, unless another place was picked meanwhile.
        if (target && form.target === target) setGenerateForm({ target: null })
      } catch (error) {
        const kept = keepInMedia(assets, {
          label,
          unit: model.output,
          start,
          usd,
          single: count === 1,
          failed: !ctx.signal.aborted,
        })
        if (kept) outcomes.set(jobId, kept)
        throw error
      } finally {
        ctx.signal.removeEventListener('abort', stopping)
        // fal.ai bills every finished request, even when a later one fails, the run is cancelled or the result is
        // lost after.
        if (usd > 0) spendLedger.record(usd, label)
      }
      const outcome = { label, assets, start, usd, clipIds: placed }
      outcomes.set(jobId, outcome)
      const name = assets.length === 1 ? (assets[0]?.name ?? 'the result') : `${assets.length} images`
      toast(
        `Added ${name} at ${formatTime(start)}`,
        { label: 'Undo', run: () => undoOutcome(outcome) },
        { show: () => showClips(outcome.clipIds) },
      )
      return outcome
    },
  })
  jobId = handle.id
  runs.set(jobId, { task: request.task, start })
}

/** Inspector › Animate with AI: Assist › Generate › Video clip from the image, landing over it. */
export function animateImage(clip: ImageClip): void {
  setGenerateForm({
    kind: 'video',
    startImageId: clip.assetId,
    target: { start: clip.start, where: `at ${formatTime(clip.start)}, over the image` },
  })
  openAssist('generate')
}

/** Where a shot right-clicked at `time` starts: the gap's start when near it, else the nearest beat in the gap. */
export function shotStart(project: Project, gap: { start: number; end: number }, time: number): number {
  if (time - gap.start < 0.5) return gap.start
  const beats = beatGridOf(project)?.beats.filter((b) => b >= gap.start && b < gap.end - 0.25) ?? []
  const nearest = beats.reduce<number | null>(
    (best, b) => (best === null || Math.abs(b - time) < Math.abs(best - time) ? b : best),
    null,
  )
  return nearest !== null && Math.abs(nearest - time) < 1 ? nearest : time
}

/** Timeline › right-click an empty stretch › Generate a shot here: Assist › Generate, landing in that gap. */
export function generateInGap(trackId: string, time: number): void {
  const project = editor.getProject()
  const gap = gapAt(project, trackId, time)
  if (!gap) return
  const start = shotStart(project, gap, time)
  const track = project.tracks.find((t) => t.id === trackId)
  const room = gap.end === Infinity ? '' : `, in the gap up to ${formatTime(gap.end)}`
  setGenerateForm({
    ...(gap.end === Infinity ? {} : { duration: gap.end - start }),
    target: {
      start,
      trackId,
      ...(gap.end === Infinity ? {} : { end: gap.end }),
      where: `at ${formatTime(start)} on ${track?.name ?? 'this track'}${room}`,
    },
  })
  openAssist('generate')
}
