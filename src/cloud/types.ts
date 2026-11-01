/**
 * Provider interfaces. The studio talks to cloud services only through these, so other providers can be added later
 * without touching the director or the UI. Every long call takes a JobContext (progress, cancel, typed errors).
 */
import type { AspectPreset, LyricWord, Seconds } from '../model/types.ts'
import type { JobContext, JobProgress } from '../shared/jobs.ts'
import type { CloudError } from './errors.ts'
import type { CostEstimate } from './pricing.ts'

export type GenerationTask = 'text-to-image' | 'image-to-video' | 'text-to-video'

/** 'draft' models are fast and cheap; 'quality' models cost more and look better. */
export type GenerationTier = 'draft' | 'quality'

export interface GenerationRequest {
  task: GenerationTask
  modelId: string
  prompt: string
  negativePrompt?: string
  /** image-to-video only: a Blob or File (uploaded to the provider automatically) or a public https URL. */
  image?: Blob | string
  aspect: AspectPreset
  /** Video length in seconds; snapped to a length the model supports (see snapDuration). */
  duration?: Seconds
  /** One of the model's resolution ids; defaults to the model's default. */
  resolution?: string
  seed?: number
}

export interface ResolutionOption {
  id: string
  label: string
}

export interface GenerationModel {
  /** Provider endpoint id, e.g. 'fal-ai/flux/schnell'. Stored in Asset.origin.provider. */
  id: string
  provider: string
  name: string
  task: GenerationTask
  tier: GenerationTier
  /** One line for the model picker. */
  description: string
  output: 'image' | 'video'
  /** Video: allowed lengths, either a list or a continuous range. */
  durations?: number[] | { min: number; max: number }
  defaultDuration?: number
  resolutions?: ResolutionOption[]
  defaultResolution?: string
  /** Rough wall-clock time of one request, for progress estimates and "usually about 1 min" hints. */
  typicalSeconds: number
  /** Shown on the model card, e.g. "$0.04 per second at 768P". */
  priceLabel: string
}

export interface GeneratedMedia {
  kind: 'image' | 'video'
  blob: Blob
  mimeType: string
  /** Provider URL the bytes came from (public, temporary). */
  sourceUrl: string
  width?: number
  height?: number
  duration?: Seconds
}

export interface GenerationResult {
  requestId: string
  modelId: string
  task: GenerationTask
  media: GeneratedMedia[]
  seed?: number
  estimate: CostEstimate
}

/** A generation request's progress: a job's, plus its place in the provider's queue while it waits there. */
export interface GenerationProgress extends JobProgress {
  /** Stage 'queue': requests ahead of this one (0 when it is next), when the provider says. */
  queuePosition?: number
}

export interface GenerationContext extends JobContext {
  progress(update: GenerationProgress): void
}

export type KeyCheck = { ok: true; message: string; models?: string[] } | { ok: false; error: CloudError }

export interface MediaGenerationProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly GenerationModel[]
  getModel(modelId: string): GenerationModel | undefined
  /** Estimated cost of one request, before any call is made. */
  estimate(request: GenerationRequest): CostEstimate
  /** Runs one generation. Throws CloudError. Cancelling stops waiting and asks the provider to cancel. */
  generate(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationResult>
  /** Checks the key without spending money. */
  validateKey(signal?: AbortSignal): Promise<KeyCheck>
}

export interface TranscriptionRequest {
  /** Audio to transcribe: ideally the separated vocals stem. Blob/File is uploaded automatically. */
  audio: Blob | string
  /** Length of the audio, used for the cost estimate. */
  durationSeconds: Seconds
  /** ISO language code; omit to auto-detect. */
  language?: string
  modelId?: string
}

/** A draft line of transcribed lyrics; words use the project's LyricWord shape. */
export interface TranscribedLine {
  text: string
  start: Seconds
  end: Seconds
  words: LyricWord[]
}

export interface TranscriptionResult {
  modelId: string
  text: string
  language?: string
  words: LyricWord[]
  lines: TranscribedLine[]
  estimate: CostEstimate
}

export interface TranscriptionProvider {
  readonly id: string
  estimateTranscription(request: Pick<TranscriptionRequest, 'durationSeconds' | 'modelId'>): CostEstimate
  transcribe(request: TranscriptionRequest, ctx: JobContext): Promise<TranscriptionResult>
}
