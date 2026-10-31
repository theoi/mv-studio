import { produce } from 'immer'
import { useSyncExternalStore } from 'react'
import { DEFAULT_FAL_MODELS, FAL_MODELS, snapDuration, type FalModel } from '../../cloud/fal/catalog.ts'
import { storeGeneratedMedia } from '../../cloud/media.ts'
import { formatUsd, needsSpendConfirmation, roundUsd } from '../../cloud/pricing.ts'
import type { GenerationRequest, GenerationTask } from '../../cloud/types.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { applyCommand, type Asset, type EditCommand, type Project } from '../../model/index.ts'
import { jobs, type JobContext, type JobProgress } from '../../shared/jobs.ts'
import { formatTime } from '../format.ts'
import { cloudServices, cloudSettings, spendLedger } from './cloud.ts'
import { assetPlacement } from './importer.ts'
import { JOB_KINDS } from './jobs.ts'
import { appMedia } from './media.ts'
import { dispatch, editor } from './project.ts'
import { get, set, toast } from './ui.ts'

/*
 * Assist › Generate: AI images and video clips with the user's fal.ai key. The form is kept here so a result or an
 * error returns to the same settings. Each run is one job; its results are stored as project media and placed on the
 * timeline at the playhead as one undo step.
 */

export type GenerateKind = 'image' | 'video'

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
}

const DEFAULT_FORM: GenerateForm = {
  kind: 'video',
  prompt: '',
  startImageId: null,
  models: {},
  duration: 5,
  count: 1,
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

/** "about $0.20", or "under $0.01" for fractions of a cent. */
export function costLabel(usd: number): string {
  return usd > 0 && usd < 0.01 ? 'under $0.01' : `about ${formatUsd(usd)}`
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
 * the first free track of its kind.
 */
export function placementCommands(project: Project, assets: Asset[], start: number): EditCommand[] {
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
    const placed = assetPlacement(working, asset, { start: at })
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

/** Maps one request's progress into its share of the job, and keeps the time left only while generating. */
function share(ctx: JobContext, from: number, to: number, prefix: string): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: (p: JobProgress) =>
      ctx.progress({
        ...p,
        ...(p.fraction !== undefined ? { fraction: from + (to - from) * p.fraction } : {}),
        ...(p.message ? { message: `${prefix}${p.message}` } : {}),
        etaSeconds: p.stage === 'generate' ? p.etaSeconds : undefined,
      }),
  }
}

/** Storing reports its own stages and fractions; the job shows one "saving" step instead. */
function saving(ctx: JobContext, fraction: number, prefix: string): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: () =>
      ctx.progress({ stage: 'store', fraction, message: `${prefix}Saving to your media library` }),
  }
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
  const start = at ?? get().playhead
  const imageId = request.task === 'image-to-video' ? f.startImageId : null
  const what = model.output === 'video' ? 'a video' : count > 1 ? `${count} images` : 'an image'
  const label =
    model.output === 'video' ? 'Generate video' : count > 1 ? `Generate ${count} images` : 'Generate image'
  let jobId = ''
  const handle = jobs.run({
    kind: JOB_KINDS.generate,
    title: `Generating ${what} · ${costLabel(estimate.usd)}`,
    run: async (ctx) => {
      const image = imageId ? editor.getProject().assets[imageId] : undefined
      const blob = image ? await appMedia.getFile(image) : undefined
      ctx.throwIfCancelled()
      const assets: Asset[] = []
      let usd = 0
      try {
        for (let i = 0; i < count; i++) {
          const prefix = count > 1 ? `Image ${i + 1} of ${count} · ` : ''
          const from = i / count
          const to = (i + 1) / count
          const result = await provider.generate(
            { ...request, ...(blob ? { image: blob } : {}) },
            share(ctx, from, from + (to - from) * 0.96, prefix),
          )
          usd += result.estimate.usd
          ctx.throwIfCancelled()
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
        // Placed against the project as it is now, at the playhead from when the user pressed Generate.
        if (!dispatch(placementCommands(editor.getProject(), assets, start), { label })) {
          throw new Error('The result could not be added to the project.')
        }
      } finally {
        // fal.ai bills every finished request, even when a later one fails or the run is cancelled.
        if (usd > 0) spendLedger.record(usd, label)
      }
      const outcome = { label, assets, start, usd }
      outcomes.set(jobId, outcome)
      const name = assets.length === 1 ? (assets[0]?.name ?? 'the result') : `${assets.length} images`
      toast(`Added ${name} at ${formatTime(start)}`, {
        label: 'Undo',
        run: () => undoOutcome(outcome),
      })
      return outcome
    },
  })
  jobId = handle.id
  runs.set(jobId, { task: request.task, start })
}
