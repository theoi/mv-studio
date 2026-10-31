/**
 * Generates the AI shots of a plan through a MediaGenerationProvider and stores the results in the media library.
 * Runs only after the user confirmed the cost. Each finished shot is reported through onShot right away, so paid
 * results survive a cancel or a later failure and are never generated twice.
 */
import { CloudError } from '../cloud/errors.ts'
import { DEFAULT_FAL_MODELS } from '../cloud/fal/catalog.ts'
import { generateKeepingPaid, storeGeneratedMedia, type GeneratedMediaStore } from '../cloud/media.ts'
import type { GenerationModel, GenerationTier, MediaGenerationProvider } from '../cloud/types.ts'
import type { Asset, Id, Project } from '../model/types.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { planRequests, type ShotRequest } from './cost.ts'
import type { GenerationOptions } from './inputs.ts'
import { generatedUnit, type EditPlan } from './plan.ts'

/** Errors that would fail every remaining shot too, so generation stops at the first one. */
const STOP_KINDS = new Set([
  'missing-key',
  'bad-key',
  'insufficient-credit',
  'model-not-found',
  'unsupported',
  'cancelled',
])

export interface GenerationChoice {
  mode: 'images' | 'video'
  tier: GenerationTier
  maxShots?: number
  imageModelId?: string
  videoModelId?: string
}

const DEFAULT_MAX_SHOTS = { images: 32, video: 12 } as const

function pickModel(
  provider: MediaGenerationProvider,
  task: GenerationModel['task'],
  tier: GenerationTier,
  wanted?: string,
) {
  const byId = (id?: string) => (id ? provider.getModel(id) : undefined)
  const fromWanted = byId(wanted)
  if (fromWanted?.task === task) return fromWanted
  const preferred = byId(DEFAULT_FAL_MODELS[task][tier])
  if (preferred?.task === task) return preferred
  return (
    provider.models.find((m) => m.task === task && m.tier === tier) ??
    provider.models.find((m) => m.task === task)
  )
}

/** Generation settings for the planner from a provider and the user's choice; undefined when the provider lacks models. */
export function generationOptionsFor(
  provider: MediaGenerationProvider,
  choice: GenerationChoice,
): GenerationOptions | undefined {
  const image = pickModel(provider, 'text-to-image', choice.tier, choice.imageModelId)
  const video = pickModel(provider, 'text-to-video', choice.tier, choice.videoModelId)
  if (!image && !(choice.mode === 'video' && video)) return undefined
  const mode = choice.mode === 'video' && video ? 'video' : 'images'
  const durations = video?.durations
  const maxVideoDuration = !durations ? 10 : Array.isArray(durations) ? Math.max(...durations) : durations.max
  return {
    mode,
    tier: choice.tier,
    imageModelId: image?.id ?? '',
    videoModelId: video?.id ?? '',
    videoDuration: Math.min(video?.defaultDuration ?? 5, maxVideoDuration),
    maxVideoDuration: Math.min(maxVideoDuration, 10),
    estimate: (request) => provider.estimate(request),
    maxShots: choice.maxShots ?? DEFAULT_MAX_SHOTS[mode],
  }
}

export interface GeneratePlanOptions {
  plan: EditPlan
  provider: MediaGenerationProvider
  store: GeneratedMediaStore
  ctx: JobContext
  /** Current project, to reuse media generated earlier from the same request. */
  project?: Project
  /** Results already made for this plan (by shot id), e.g. before a cancel. */
  done?: ReadonlyMap<string, Asset>
  /** Reads the still for image-to-video shots. */
  readAsset?: (assetId: Id) => Promise<Blob>
  onShot?: (shotId: string, asset: Asset) => void
  /** Once per request the provider finished and billed, with its estimated cost, even if its result is lost after. */
  onBilled?: (usd: number) => void
  /** After each shot settles: how many are finished (made or failed) and how many failed, of `total`. */
  onProgress?: (counts: { done: number; failed: number; total: number }) => void
  /** Requests in flight at once (default 2). */
  concurrency?: number
}

export interface GeneratedShots {
  /** Generated or reused media by shot id, including `done`. */
  assets: Map<string, Asset>
  failed: { shotId: string; label: string; error: JobError }[]
  /** Estimated spend of the requests the provider finished (and billed) in this run. */
  spentUsd: number
}

interface Underway {
  fraction: number
  eta?: number
  downloading: boolean
}

function isStopError(error: JobError): boolean {
  return error.code === 'cancelled' || (error instanceof CloudError && STOP_KINDS.has(error.kind))
}

export async function generatePlanShots(o: GeneratePlanOptions): Promise<GeneratedShots> {
  const assets = new Map(o.done ?? [])
  const all = planRequests(o.plan, o.project)
  for (const r of all) if (r.reuse && !assets.has(r.shot.id)) assets.set(r.shot.id, r.reuse)
  const queue: ShotRequest[] = all.filter((r) => !assets.has(r.shot.id))
  const total = queue.length
  const failed: GeneratedShots['failed'] = []
  let spentUsd = 0
  let finished = 0
  let stop: JobError | undefined
  const unit = generatedUnit(o.plan)
  const workers = Math.max(1, Math.min(o.concurrency ?? 2, total))
  const typical = (r: ShotRequest) => o.provider.getModel(r.request.modelId)?.typicalSeconds
  /** Shots underway: their own progress, the seconds they still need, and whether their result is downloading. */
  const underway = new Map<ShotRequest, Underway>()
  let shown = 0
  const report = () => {
    // Shots underway count by their own progress, so the bar moves during a clip that takes minutes. Each one's
    // progress only grows, and a shot that settles moves to 1, so the sum never goes back.
    let partial = 0
    for (const u of underway.values()) partial += u.fraction
    shown = Math.max(shown, total ? Math.min(1, (finished + partial) / total) : 1)
    if (o.ctx.signal.aborted) {
      // After a Cancel the run still waits for the results that are downloading, so say the Cancel was received.
      const keeping = [...underway.values()].filter((u) => u.downloading).length
      o.ctx.progress({
        fraction: shown,
        stage: 'stopping',
        message: keeping
          ? `Stopping… keeping ${keeping} ${unit}${keeping === 1 ? ' that is' : 's that are'} downloading`
          : 'Stopping…',
        etaSeconds: undefined,
      })
      return
    }
    const waiting = queue.reduce((sum, r) => sum + (typical(r) ?? 0), 0)
    const etas = [...underway.values()].map((u) => u.eta ?? 0)
    const etaSeconds = Math.round(Math.max(0, ...etas) + waiting / workers)
    o.ctx.progress({
      fraction: shown,
      stage: 'generate',
      message: total
        ? `Generating ${unit} ${Math.min(total, finished + 1)} of ${total}`
        : `Using ${unit}s made earlier`,
      // Clips take minutes each, so they say how long is left; images are done in seconds.
      ...(unit === 'clip' && total && etaSeconds > 0 ? { etaSeconds } : {}),
    })
  }
  report()
  o.ctx.signal.addEventListener('abort', report, { once: true })

  const runOne = async (r: ShotRequest) => {
    const request = { ...r.request }
    if (r.request.task === 'image-to-video') {
      const stillId = r.shot.source.imageAssetId
      const still = stillId ? (assets.get(stillId)?.id ?? stillId) : undefined
      if (!still || !o.readAsset)
        throw new JobError('invalid-input', 'This shot needs a still image to animate.')
      request.image = await o.readAsset(still)
    }
    const own: Underway = { fraction: 0, eta: typical(r), downloading: false }
    underway.set(r, own)
    // A request's progress feeds the shot's share of the bar; its message stays its own, under the shot count.
    const shotCtx: JobContext = {
      signal: o.ctx.signal,
      throwIfCancelled: () => o.ctx.throwIfCancelled(),
      progress: (p) => {
        if (p.stage === 'download') own.downloading = true
        if (p.fraction === undefined && p.etaSeconds === undefined) return
        if (p.fraction !== undefined) own.fraction = Math.max(own.fraction, Math.min(0.95, p.fraction))
        if (p.etaSeconds !== undefined) own.eta = p.etaSeconds
        report()
      },
    }
    // A cancel stops the request only until the provider has finished (and billed) it; a result downloading by then
    // is kept.
    const result = await generateKeepingPaid(o.provider, request, shotCtx, {
      onBilled: (usd) => {
        spentUsd += usd
        o.onBilled?.(usd)
      },
    })
    const [asset] = await storeGeneratedMedia(result, o.store, {
      prompt: request.prompt,
      name: r.shot.label ? `AI: ${r.shot.label}` : undefined,
    })
    if (!asset) throw new JobError('provider', 'The provider returned no media for this shot.')
    assets.set(r.shot.id, asset)
    o.onShot?.(r.shot.id, asset)
  }

  const worker = async () => {
    while (queue.length > 0 && !stop) {
      // Stop without throwing, so the run waits for a shot another worker is still downloading and keeps it.
      if (o.ctx.signal.aborted) {
        stop ??= new JobError('cancelled', 'Cancelled')
        break
      }
      const r = queue.shift() as ShotRequest
      try {
        await runOne(r)
      } catch (error) {
        const err = o.ctx.signal.aborted
          ? new JobError('cancelled', 'Cancelled', { cause: error })
          : JobError.from(error)
        if (isStopError(err)) stop ??= err
        else failed.push({ shotId: r.shot.id, label: r.shot.label ?? `AI ${unit}`, error: err })
      }
      underway.delete(r)
      finished++
      report()
      o.onProgress?.({ done: finished, failed: failed.length, total })
    }
  }
  try {
    await Promise.all(Array.from({ length: workers }, worker))
  } finally {
    o.ctx.signal.removeEventListener('abort', report)
  }
  if (stop) throw stop
  if (total > 0 && failed.length === total) throw failed[0]?.error
  return { assets, failed, spentUsd }
}
