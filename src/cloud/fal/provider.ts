/**
 * fal.ai adapter: image and video generation plus optional cloud transcription, through @fal-ai/client's queue API.
 * The browser calls fal directly with the user's key (fal sends CORS headers for queue, storage and media hosts).
 */
import { ApiError, createFalClient, type FalClient } from '@fal-ai/client'
import type { JobContext } from '../../shared/jobs.ts'
import { CloudError } from '../errors.ts'
import { PRICES_CHECKED_ON, roundUsd, type CostEstimate } from '../pricing.ts'
import type {
  GeneratedMedia,
  GenerationRequest,
  GenerationResult,
  KeyCheck,
  MediaGenerationProvider,
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from '../types.ts'
import { FAL_MODELS, falModel, type FalModel } from './catalog.ts'
import { falKeyCheckNoAnswerError, falKeyFormatError, falMissingKeyError, mapFalError } from './errors.ts'
import { parseTranscription, transcriptionModel } from './transcribe.ts'

export interface FalProviderOptions {
  /** Read on every request so a new key applies immediately. */
  getKey: () => string
  fetch?: typeof fetch
  pollIntervalMs?: number
  /** Give up waiting after this long (the request is cancelled at fal.ai). */
  timeoutMs?: number
  /** How long a key check waits for fal.ai's answer. */
  keyCheckTimeoutMs?: number
  now?: () => number
}

/** Shown next to Cancel for paid generation. */
export const FAL_CANCEL_NOTICE =
  'Cancelling stops the request if it is still waiting in line. fal.ai may still charge for one that already started.'

const NIL_REQUEST_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Settles as soon as `signal` aborts. The fal client retries a failed status request up to five times, and its waits
 * between tries don't listen to the signal.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))

/** The major and compatible brands of an ISO-BMFF `ftyp` box, as far as `head` holds them. */
function brands(head: Uint8Array): string[] {
  if (ascii(head, 4, 8) !== 'ftyp') return []
  const end = Math.min(new DataView(head.buffer, head.byteOffset).getUint32(0), head.length)
  const found = [ascii(head, 8, 12)]
  for (let at = 16; at + 4 <= end; at += 4) found.push(ascii(head, at, at + 4))
  return found
}

/** Image formats by their first bytes, with the extension that goes with each. */
const IMAGE_FORMATS: readonly { type: string; ext: string; is: (head: Uint8Array) => boolean }[] = [
  { type: 'image/png', ext: 'png', is: (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  { type: 'image/jpeg', ext: 'jpg', is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', is: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { type: 'image/gif', ext: 'gif', is: (b) => ascii(b, 0, 4) === 'GIF8' },
  {
    type: 'image/avif',
    ext: 'avif',
    // The major brand can be the generic mif1 or msf1, with avif among the compatible ones.
    is: (b) => brands(b).some((brand) => brand === 'avif' || brand === 'avis'),
  },
]

/**
 * The image as a file with its real type and a name ending in the matching extension. Files read back from browser
 * storage have no type, and a generated image's stored name has no extension, so fal.ai would otherwise keep it as
 * application/octet-stream under a name without one.
 */
async function asImageFile(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  const format = IMAGE_FORMATS.find((f) => f.is(head)) ?? IMAGE_FORMATS.find((f) => f.type === blob.type)
  if (!format) return blob
  const name = blob instanceof File ? blob.name.replace(/\.[a-z0-9]{1,5}$/i, '') : ''
  const base =
    name
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 60)
      .replace(/[-.]+$/, '') || 'image'
  return new File([blob], `${base}.${format.ext}`, { type: format.type })
}

export function humanDuration(seconds: number): string {
  if (seconds < 10) return 'a few seconds'
  if (seconds < 50) return `about ${Math.round(seconds / 5) * 5} s`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `about ${minutes} min`
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class FalProvider implements MediaGenerationProvider, TranscriptionProvider {
  readonly id = 'fal'
  readonly name = 'fal.ai'
  readonly models: readonly FalModel[] = FAL_MODELS
  private readonly client: FalClient
  private readonly options: Required<Omit<FalProviderOptions, 'fetch'>> & { fetch: typeof fetch }

  constructor(options: FalProviderOptions) {
    const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.options = {
      getKey: options.getKey,
      fetch: doFetch,
      pollIntervalMs: options.pollIntervalMs ?? 1500,
      timeoutMs: options.timeoutMs ?? 20 * 60_000,
      keyCheckTimeoutMs: options.keyCheckTimeoutMs ?? 15_000,
      now: options.now ?? (() => Date.now()),
    }
    this.client = createFalClient({
      credentials: () => this.options.getKey() || undefined,
      // The key belongs to the user and is entered in this browser on purpose; there is no server to proxy through.
      suppressLocalCredentialsWarning: true,
      fetch: doFetch,
    })
  }

  getModel(modelId: string): FalModel | undefined {
    return falModel(modelId)
  }

  estimate(request: GenerationRequest): CostEstimate {
    return this.requireModel(request).estimate(request)
  }

  async validateKey(signal?: AbortSignal): Promise<KeyCheck> {
    const key = this.options.getKey()
    if (!key) return { ok: false, error: falMissingKeyError() }
    if (!/^[^:\s]+:[^:\s]+$/.test(key)) return { ok: false, error: falKeyFormatError() }
    const waitMs = this.options.keyCheckTimeoutMs
    const timeout = AbortSignal.timeout(waitMs)
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      // Status of a request that doesn't exist: free, and fal checks the key before looking the request up.
      await untilAborted(
        this.client.queue.status('fal-ai/flux', { requestId: NIL_REQUEST_ID, abortSignal }),
        abortSignal,
      )
      return { ok: true, message: 'fal.ai accepted the key.' }
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        return { ok: false, error: falKeyCheckNoAnswerError(waitMs / 1000, error) }
      }
      if (error instanceof ApiError && [400, 404, 405, 422].includes(error.status)) {
        return { ok: true, message: 'fal.ai accepted the key.' }
      }
      return { ok: false, error: mapFalError(error, { key, signal }) }
    }
  }

  async generate(request: GenerationRequest, ctx: JobContext): Promise<GenerationResult> {
    const model = this.requireModel(request)
    const key = this.requireKey()
    const estimate = model.estimate(request)
    if (!request.prompt.trim() && request.task !== 'image-to-video') {
      throw new CloudError({
        kind: 'invalid-request',
        provider: 'fal',
        title: 'Describe what to generate',
        message: 'The prompt is empty.',
        steps: ['Write a short description of the shot.'],
      })
    }
    let image: string | undefined
    if (request.task === 'image-to-video') {
      if (!request.image) {
        throw new CloudError({
          kind: 'invalid-request',
          provider: 'fal',
          title: 'Pick an image to animate',
          message: 'Image-to-video needs a still image.',
          steps: ['Select an image clip or generate an image first.'],
        })
      }
      image =
        typeof request.image === 'string'
          ? request.image
          : await this.upload(request.image, ctx, key, 'image')
    }
    const input = model.buildInput({ ...request, image })
    const { data, requestId } = await this.runQueue(model.id, input, model.typicalSeconds, ctx, key)
    if (model.output === 'image') {
      const flags = (data as { has_nsfw_concepts?: unknown })?.has_nsfw_concepts
      if (Array.isArray(flags) && flags.length > 0 && flags.every((f) => f === true)) {
        throw new CloudError({
          kind: 'content-policy',
          provider: 'fal',
          title: 'The image was blocked by the safety filter',
          message: 'fal.ai flagged the result, so nothing was added to your project.',
          steps: ['Rephrase the prompt and try again.'],
        })
      }
    }
    const files = model.parseOutput(data)
    if (files.length === 0) {
      throw new CloudError({
        kind: 'bad-response',
        provider: 'fal',
        title: 'fal.ai returned no result',
        message: 'The request finished but did not include a file.',
        steps: ['Try again.'],
      })
    }
    const media: GeneratedMedia[] = []
    for (const [i, file] of files.entries()) {
      ctx.progress({
        stage: 'download',
        fraction: 0.92 + (0.08 * i) / files.length,
        message: model.output === 'video' ? 'Downloading the video' : 'Downloading the image',
      })
      const blob = await this.download(file.url, ctx, key)
      media.push({
        kind: model.output,
        blob,
        mimeType: blob.type || file.contentType || (model.output === 'video' ? 'video/mp4' : 'image/jpeg'),
        sourceUrl: file.url,
        width: file.width,
        height: file.height,
        duration: file.duration,
      })
    }
    const seed = (data as { seed?: unknown })?.seed
    return {
      requestId,
      modelId: model.id,
      task: model.task,
      media,
      seed: typeof seed === 'number' ? seed : undefined,
      estimate,
    }
  }

  estimateTranscription(request: Pick<TranscriptionRequest, 'durationSeconds' | 'modelId'>): CostEstimate {
    const model = transcriptionModel(request.modelId)
    const minutes = Math.max(0, request.durationSeconds) / 60
    return {
      usd: roundUsd(Math.ceil(minutes * model.usdPerMinute * 100) / 100),
      approximate: false,
      breakdown: `${minutes.toFixed(1)} min × $${model.usdPerMinute.toFixed(2)}/min`,
      pricesCheckedOn: PRICES_CHECKED_ON,
    }
  }

  async transcribe(request: TranscriptionRequest, ctx: JobContext): Promise<TranscriptionResult> {
    const model = transcriptionModel(request.modelId)
    const key = this.requireKey()
    const estimate = this.estimateTranscription(request)
    const audioUrl =
      typeof request.audio === 'string' ? request.audio : await this.upload(request.audio, ctx, key, 'audio')
    const input = model.buildInput({ audioUrl, language: request.language })
    const typical = 15 + request.durationSeconds / 8
    const { data } = await this.runQueue(model.id, input, typical, ctx, key)
    const parsed = parseTranscription(data)
    if (!parsed) {
      throw new CloudError({
        kind: 'bad-response',
        provider: 'fal',
        title: 'The transcription came back empty',
        message: 'fal.ai finished but returned no timed words.',
        steps: ['Check that the audio has vocals, then choose Retry.'],
      })
    }
    return { ...parsed, modelId: model.id, estimate }
  }

  private requireModel(request: GenerationRequest): FalModel {
    const model = falModel(request.modelId)
    if (!model || model.task !== request.task) {
      throw new CloudError({
        kind: 'model-not-found',
        provider: 'fal',
        title: 'Unknown model',
        message: `${request.modelId} isn’t a ${request.task} model in MV Studio’s list.`,
        steps: ['Pick a model from the list.'],
      })
    }
    return model
  }

  private requireKey(): string {
    const key = this.options.getKey()
    if (!key) throw falMissingKeyError()
    return key
  }

  private async upload(blob: Blob, ctx: JobContext, key: string, what: 'image' | 'audio'): Promise<string> {
    ctx.progress({
      stage: 'upload',
      fraction: 0.02,
      message: what === 'image' ? 'Uploading the image' : 'Uploading the audio',
    })
    try {
      const url = await this.client.storage.upload(what === 'image' ? await asImageFile(blob) : blob)
      ctx.throwIfCancelled()
      return url
    } catch (error) {
      throw mapFalError(error, { key, signal: ctx.signal })
    }
  }

  private async runQueue(
    endpointId: string,
    input: Record<string, unknown>,
    typicalSeconds: number,
    ctx: JobContext,
    key: string,
  ): Promise<{ data: unknown; requestId: string }> {
    const { signal } = ctx
    const fail = (error: unknown) => mapFalError(error, { key, signal })
    ctx.progress({ stage: 'submit', fraction: 0.04, message: 'Sending the request to fal.ai' })
    let requestId: string
    try {
      requestId = (await this.client.queue.submit(endpointId, { input, abortSignal: signal })).request_id
    } catch (error) {
      throw fail(error)
    }
    const cancelAtFal = () => {
      void this.client.queue.cancel(endpointId, { requestId }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancelAtFal, { once: true })
    try {
      const started = this.options.now()
      let generatingSince: number | undefined
      for (;;) {
        if (signal.aborted) throw fail(signal.reason)
        if (this.options.now() - started > this.options.timeoutMs) {
          cancelAtFal()
          throw new CloudError({
            kind: 'timeout',
            provider: 'fal',
            title: 'Generation took too long',
            message: `No result after ${humanDuration(this.options.timeoutMs / 1000)}, so the request was cancelled.`,
            steps: ['Try again, or pick a faster model.'],
          })
        }
        let status
        try {
          status = await this.client.queue.status(endpointId, { requestId, logs: true, abortSignal: signal })
        } catch (error) {
          throw fail(error)
        }
        if (status.status === 'COMPLETED') break
        if (status.status === 'IN_QUEUE') {
          const position = status.queue_position
          ctx.progress({
            stage: 'queue',
            fraction: 0.06,
            message:
              typeof position === 'number' && position > 0
                ? `Waiting in line at fal.ai (${position} ahead)`
                : 'Waiting in line at fal.ai',
          })
        } else {
          generatingSince ??= this.options.now()
          const elapsed = (this.options.now() - generatingSince) / 1000
          ctx.progress({
            stage: 'generate',
            fraction: 0.1 + 0.8 * (1 - Math.exp(-elapsed / Math.max(1, typicalSeconds))),
            etaSeconds: Math.max(0, Math.round(typicalSeconds - elapsed)),
            message: `Generating, usually ${humanDuration(typicalSeconds)}`,
          })
        }
        await sleep(this.options.pollIntervalMs, signal)
      }
      // fal.ai bills a request once it is COMPLETED, so fetching the result already counts as its download.
      ctx.progress({ stage: 'download', fraction: 0.9 })
      try {
        const result = await this.client.queue.result(endpointId, { requestId, abortSignal: signal })
        return { data: result.data, requestId }
      } catch (error) {
        const err = fail(error)
        // A request fal.ai failed itself still reaches COMPLETED and returns the error here; fal.ai doesn't charge
        // for its server errors (500 and up).
        if ((err.status ?? 0) < 500) throw err
        throw new CloudError({ ...err.info, message: err.message, cause: error, uncharged: true })
      }
    } finally {
      signal.removeEventListener('abort', cancelAtFal)
    }
  }

  private async download(url: string, ctx: JobContext, key: string): Promise<Blob> {
    try {
      const response = await this.options.fetch(url, { signal: ctx.signal, credentials: 'omit' })
      if (!response.ok) {
        throw new CloudError({
          kind: 'server',
          provider: 'fal',
          status: response.status,
          title: 'Couldn’t download the result',
          message: `fal.ai’s file host returned ${response.status}.`,
          steps: ['Try again.'],
        })
      }
      return await response.blob()
    } catch (error) {
      throw mapFalError(error, { key, signal: ctx.signal })
    }
  }
}
