/** Puts generated images and videos into the project's media storage and returns the edit commands to add them. */
import type { MediaStore } from '../media/types.ts'
import type { EditCommand } from '../model/commands.ts'
import type { Asset } from '../model/types.ts'
import { JobError, type JobContext, type JobHandle, type JobRunner } from '../shared/jobs.ts'
import { CloudError } from './errors.ts'
import { formatUsd } from './pricing.ts'
import type { GenerationRequest, GenerationResult, GenerationTask, MediaGenerationProvider } from './types.ts'

export type GeneratedMediaStore = Pick<MediaStore, 'storeBlob'>

export interface GeneratedAssets {
  result: GenerationResult
  assets: Asset[]
  /** `asset.add` commands; dispatch them (with any clip.add) as one undo step. */
  commands: EditCommand[]
}

const TASK_LABEL: Record<GenerationTask, string> = {
  'text-to-image': 'AI image',
  'image-to-video': 'AI video',
  'text-to-video': 'AI video',
}

export function generatedAssetName(task: GenerationTask, prompt: string): string {
  const words = prompt.trim().replace(/\s+/g, ' ')
  const short = words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words
  return short ? `${TASK_LABEL[task]}: ${short}` : TASK_LABEL[task]
}

export async function storeGeneratedMedia(
  result: GenerationResult,
  store: GeneratedMediaStore,
  info: { prompt: string; name?: string },
  ctx?: JobContext,
): Promise<Asset[]> {
  const assets: Asset[] = []
  for (const [i, media] of result.media.entries()) {
    ctx?.progress({ stage: 'store', message: 'Saving to your media library' })
    const base = info.name ?? generatedAssetName(result.task, info.prompt)
    const asset = await store.storeBlob(
      media.blob,
      {
        kind: media.kind,
        name: result.media.length > 1 ? `${base} (${i + 1})` : base,
        origin: { type: 'generated', provider: result.modelId, prompt: info.prompt },
      },
      ctx,
    )
    assets.push(asset)
  }
  return assets
}

/** Generates, downloads and stores the result. Nothing is added to the project until the commands are dispatched. */
export async function generateIntoLibrary(
  provider: MediaGenerationProvider,
  request: GenerationRequest,
  store: GeneratedMediaStore,
  ctx: JobContext,
): Promise<GeneratedAssets> {
  const result = await provider.generate(request, ctx)
  ctx.throwIfCancelled()
  const assets = await storeGeneratedMedia(result, store, { prompt: request.prompt }, ctx)
  return { result, assets, commands: assets.map((asset) => ({ type: 'asset.add', asset })) }
}

/** Runs one generation as a job ("Generating a video · about $0.20") so it shows in the activity indicator. */
export function startGenerationJob(
  runner: JobRunner,
  provider: MediaGenerationProvider,
  request: GenerationRequest,
  store: GeneratedMediaStore,
): JobHandle<GeneratedAssets> {
  const what = request.task === 'text-to-image' ? 'an image' : 'a video'
  const cost = formatUsd(provider.estimate(request).usd)
  return runner.run({
    kind: `cloud.generate.${request.task}`,
    title: `Generating ${what} · about ${cost}`,
    run: (ctx) => generateIntoLibrary(provider, request, store, ctx),
  })
}

/** How long a cancelled job still waits for a result that is downloading. It is paid for by then. */
export const PAID_RESULT_GRACE_MS = 30_000

export interface PaidRequestOptions {
  /** Called once, when the provider has finished the request and billed it. */
  onBilled?: (usd: number) => void
  graceMs?: number
}

/**
 * Runs one paid request. Cancelling `ctx` stops it at once only until the provider has finished it. From stage
 * `download` on (fal.ai reports it at COMPLETED, when it bills), the result is paid for: the request then gets
 * `graceMs` more to bring it back, to be kept, and is aborted only if it is still stalled after that. `onBilled`
 * runs once the request settles: when it returns, or when it fails after `download` (a billed result that is lost
 * still counts), unless the provider marks the failure `uncharged`.
 */
export async function generateKeepingPaid(
  provider: MediaGenerationProvider,
  request: GenerationRequest,
  ctx: JobContext,
  options: PaidRequestOptions = {},
): Promise<GenerationResult> {
  const abort = new AbortController()
  let finished = false
  let grace: ReturnType<typeof setTimeout> | undefined
  const bill = () => options.onBilled?.(provider.estimate(request).usd)
  const onCancel = () => {
    if (!finished) abort.abort(ctx.signal.reason)
    else grace ??= setTimeout(() => abort.abort(ctx.signal.reason), options.graceMs ?? PAID_RESULT_GRACE_MS)
  }
  if (ctx.signal.aborted) onCancel()
  else ctx.signal.addEventListener('abort', onCancel, { once: true })
  try {
    const result = await provider.generate(request, {
      signal: abort.signal,
      throwIfCancelled: () => {
        if (abort.signal.aborted) throw new JobError('cancelled', 'Cancelled')
      },
      progress: (p) => {
        if (p.stage === 'download') finished = true
        ctx.progress(p)
      },
    })
    bill()
    return result
  } catch (error) {
    if (finished && !(error instanceof CloudError && error.uncharged)) bill()
    throw error
  } finally {
    ctx.signal.removeEventListener('abort', onCancel)
    clearTimeout(grace)
  }
}
