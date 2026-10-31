/**
 * Curated fal.ai models with their input shapes and prices. Input fields and enums were checked against each
 * endpoint's OpenAPI schema (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>) and prices against the
 * model pages on PRICES_CHECKED_ON. Re-check both when adding or updating a model.
 */
import type { AspectPreset } from '../../model/types.ts'
import { PRICES_CHECKED_ON, roundUsd, type CostEstimate } from '../pricing.ts'
import type { GenerationModel, GenerationRequest } from '../types.ts'

/** fal bills image models per megapixel of 1024 × 1024 pixels, rounded up. */
const MEGAPIXEL = 1024 * 1024

export interface FalOutputFile {
  url: string
  width?: number
  height?: number
  contentType?: string
  duration?: number
}

export interface FalModel extends GenerationModel {
  provider: 'fal'
  estimate(request: GenerationRequest): CostEstimate
  /** Builds the endpoint input. `image` is already a URL (uploaded beforehand) for image-to-video. */
  buildInput(request: GenerationRequest & { image?: string }): Record<string, unknown>
  parseOutput(data: unknown): FalOutputFile[]
}

/** Image sizes per aspect. Draft sizes bill as 1 MP and quality sizes as 2 MP. */
export const IMAGE_SIZES: Record<
  AspectPreset,
  Record<'draft' | 'quality', { width: number; height: number }>
> = {
  '16:9': { draft: { width: 1280, height: 720 }, quality: { width: 1920, height: 1088 } },
  '9:16': { draft: { width: 720, height: 1280 }, quality: { width: 1088, height: 1920 } },
  '1:1': { draft: { width: 1024, height: 1024 }, quality: { width: 1440, height: 1440 } },
  '4:5': { draft: { width: 816, height: 1024 }, quality: { width: 1280, height: 1600 } },
}

function estimate(usd: number, breakdown: string, approximate = false): CostEstimate {
  return { usd: roundUsd(usd), approximate, breakdown, pricesCheckedOn: PRICES_CHECKED_ON }
}

function megapixels(size: { width: number; height: number }): number {
  return Math.max(1, Math.ceil((size.width * size.height) / MEGAPIXEL))
}

function money(usd: number): string {
  return `$${usd < 0.1 ? usd.toFixed(3).replace(/0$/, '') : usd.toFixed(2)}`
}

function imagesFrom(data: unknown): FalOutputFile[] {
  const images = (data as { images?: unknown })?.images
  if (!Array.isArray(images)) return []
  return images
    .filter(
      (i): i is Record<string, unknown> => typeof i === 'object' && i !== null && typeof i.url === 'string',
    )
    .map((i) => ({
      url: i.url as string,
      width: typeof i.width === 'number' ? i.width : undefined,
      height: typeof i.height === 'number' ? i.height : undefined,
      contentType: typeof i.content_type === 'string' ? i.content_type : undefined,
    }))
}

function videoFrom(data: unknown): FalOutputFile[] {
  const video = (data as { video?: unknown })?.video as Record<string, unknown> | undefined
  if (!video || typeof video.url !== 'string') return []
  return [
    {
      url: video.url,
      width: typeof video.width === 'number' ? video.width : undefined,
      height: typeof video.height === 'number' ? video.height : undefined,
      contentType: typeof video.content_type === 'string' ? video.content_type : undefined,
      duration: typeof video.duration === 'number' ? video.duration : undefined,
    },
  ]
}

/** The closest length the model supports that is at least `requested` (or its maximum). */
export function snapDuration(model: GenerationModel, requested?: number): number {
  const durations = model.durations
  const wanted = requested ?? model.defaultDuration ?? 5
  if (!durations) return wanted
  if (Array.isArray(durations)) {
    const sorted = [...durations].sort((a, b) => a - b)
    return sorted.find((d) => d >= wanted - 1e-6) ?? sorted[sorted.length - 1] ?? wanted
  }
  const clamped = Math.min(durations.max, Math.max(durations.min, wanted))
  return Math.ceil(clamped * 10) / 10
}

function resolutionOf(model: GenerationModel, requested?: string): string {
  const ids = model.resolutions?.map((r) => r.id) ?? []
  if (requested && ids.includes(requested)) return requested
  return model.defaultResolution ?? ids[0] ?? ''
}

function aspectFor(aspect: AspectPreset, allowed: string[]): string {
  if (allowed.includes(aspect)) return aspect
  const ratio = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }[aspect]
  let best = allowed[0] ?? aspect
  let bestDiff = Infinity
  for (const a of allowed) {
    const [w, h] = a.split(':').map(Number)
    if (!w || !h) continue
    const diff = Math.abs(Math.log(w / h / ratio))
    if (diff < bestDiff) {
      bestDiff = diff
      best = a
    }
  }
  return best
}

function perMegapixelModel(o: {
  id: string
  name: string
  tier: 'draft' | 'quality'
  description: string
  usdPerMp: number
  typicalSeconds: number
  extraInput?: Record<string, unknown>
}): FalModel {
  return {
    id: o.id,
    provider: 'fal',
    name: o.name,
    task: 'text-to-image',
    tier: o.tier,
    description: o.description,
    output: 'image',
    typicalSeconds: o.typicalSeconds,
    priceLabel: `${money(o.usdPerMp)} per megapixel`,
    estimate(request) {
      const size = IMAGE_SIZES[request.aspect][o.tier]
      const mp = megapixels(size)
      return estimate(mp * o.usdPerMp, `${mp} MP × ${money(o.usdPerMp)}`)
    },
    buildInput(request) {
      return {
        prompt: request.prompt,
        image_size: IMAGE_SIZES[request.aspect][o.tier],
        num_images: 1,
        enable_safety_checker: true,
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...o.extraInput,
      }
    },
    parseOutput: imagesFrom,
  }
}

function perSecondVideoModel(o: {
  id: string
  name: string
  task: 'image-to-video' | 'text-to-video'
  tier: 'draft' | 'quality'
  description: string
  durations: number[] | { min: number; max: number }
  defaultDuration: number
  /** US dollars per second, by resolution id. */
  usdPerSecond: Record<string, number>
  resolutions: { id: string; label: string }[]
  defaultResolution: string
  typicalSeconds: number
  input(
    request: GenerationRequest & { image?: string },
    duration: number,
    resolution: string,
  ): Record<string, unknown>
}): FalModel {
  const model: FalModel = {
    id: o.id,
    provider: 'fal',
    name: o.name,
    task: o.task,
    tier: o.tier,
    description: o.description,
    output: 'video',
    durations: o.durations,
    defaultDuration: o.defaultDuration,
    resolutions: o.resolutions,
    defaultResolution: o.defaultResolution,
    typicalSeconds: o.typicalSeconds,
    priceLabel: `${money(o.usdPerSecond[o.defaultResolution] ?? 0)} per second at ${o.defaultResolution}`,
    estimate(request) {
      const duration = snapDuration(model, request.duration)
      const resolution = resolutionOf(model, request.resolution)
      const rate = o.usdPerSecond[resolution] ?? Math.max(...Object.values(o.usdPerSecond))
      return estimate(duration * rate, `${duration} s × ${money(rate)}/s at ${resolution}`)
    },
    buildInput(request) {
      const duration = snapDuration(model, request.duration)
      const resolution = resolutionOf(model, request.resolution)
      return o.input(request, duration, resolution)
    },
    parseOutput: videoFrom,
  }
  return model
}

const seed = (r: GenerationRequest) => (r.seed !== undefined ? { seed: r.seed } : {})

export const FAL_MODELS: readonly FalModel[] = [
  // Text to image
  perMegapixelModel({
    id: 'fal-ai/flux/schnell',
    name: 'FLUX.1 schnell',
    tier: 'draft',
    description: 'Fast drafts and storyboards in about a second.',
    usdPerMp: 0.003,
    typicalSeconds: 3,
    extraInput: { num_inference_steps: 4, output_format: 'jpeg' },
  }),
  perMegapixelModel({
    id: 'fal-ai/z-image/turbo',
    name: 'Z-Image Turbo',
    tier: 'draft',
    description: 'Fast, sharper drafts.',
    usdPerMp: 0.005,
    typicalSeconds: 4,
    extraInput: { output_format: 'jpeg' },
  }),
  {
    id: 'fal-ai/flux-2-pro',
    provider: 'fal',
    name: 'FLUX.2 pro',
    task: 'text-to-image',
    tier: 'quality',
    description: 'High-quality, detailed images.',
    output: 'image',
    typicalSeconds: 12,
    priceLabel: '$0.03 for the first megapixel, $0.015 for each extra one',
    estimate(request) {
      const mp = megapixels(IMAGE_SIZES[request.aspect].quality)
      return estimate(0.03 + 0.015 * (mp - 1), `${mp} MP: $0.03 + ${mp - 1} × $0.015`)
    },
    buildInput(request) {
      return {
        prompt: request.prompt,
        image_size: IMAGE_SIZES[request.aspect].quality,
        enable_safety_checker: true,
        output_format: 'jpeg',
        ...seed(request),
      }
    },
    parseOutput: imagesFrom,
  },
  {
    id: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    provider: 'fal',
    name: 'Seedream 4.5',
    task: 'text-to-image',
    tier: 'quality',
    description: 'High-quality images with strong composition.',
    output: 'image',
    typicalSeconds: 20,
    priceLabel: '$0.04 per image',
    estimate: () => estimate(0.04, '1 image × $0.04'),
    buildInput(request) {
      return {
        prompt: request.prompt,
        image_size: IMAGE_SIZES[request.aspect].quality,
        num_images: 1,
        enable_safety_checker: true,
        ...seed(request),
      }
    },
    parseOutput: imagesFrom,
  },

  // Image to video
  perSecondVideoModel({
    id: 'minimax/h3-max-turbo/image-to-video',
    name: 'MiniMax H3 Max Turbo',
    task: 'image-to-video',
    tier: 'draft',
    description: 'Fast, affordable motion from a still. Any length up to 15 s.',
    durations: { min: 1, max: 15 },
    defaultDuration: 5,
    usdPerSecond: { '480P': 0.025, '768P': 0.04, '1080P': 0.08 },
    resolutions: [
      { id: '480P', label: '480p' },
      { id: '768P', label: '768p' },
      { id: '1080P', label: '1080p' },
    ],
    defaultResolution: '768P',
    typicalSeconds: 90,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      image_url: r.image,
      duration,
      resolution,
      prompt_expansion_mode: 'balanced',
      enable_safety_checker: true,
      ...seed(r),
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    name: 'Hailuo 02 Standard',
    task: 'image-to-video',
    tier: 'draft',
    description: 'Reliable motion at 768p, 6 or 10 seconds.',
    durations: [6, 10],
    defaultDuration: 6,
    usdPerSecond: { '768P': 0.045 },
    resolutions: [{ id: '768P', label: '768p' }],
    defaultResolution: '768P',
    typicalSeconds: 150,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      image_url: r.image,
      duration: String(duration),
      resolution,
      prompt_optimizer: true,
      enable_safety_checker: true,
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    name: 'Kling 3 Pro',
    task: 'image-to-video',
    tier: 'quality',
    description: 'Cinematic motion, 3 to 15 seconds.',
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    usdPerSecond: { default: 0.112 },
    resolutions: [{ id: 'default', label: 'Standard' }],
    defaultResolution: 'default',
    typicalSeconds: 180,
    input: (r, duration) => ({
      prompt: r.prompt,
      start_image_url: r.image,
      duration: String(duration),
      // The song is the soundtrack, and audio costs more.
      generate_audio: false,
      enable_safety_checker: true,
      ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/veo3.1/fast/image-to-video',
    name: 'Veo 3.1 Fast',
    task: 'image-to-video',
    tier: 'quality',
    description: 'Natural motion and lighting, 4, 6 or 8 seconds.',
    durations: [4, 6, 8],
    defaultDuration: 6,
    usdPerSecond: { '720p': 0.1, '1080p': 0.1 },
    resolutions: [
      { id: '720p', label: '720p' },
      { id: '1080p', label: '1080p' },
    ],
    defaultResolution: '720p',
    typicalSeconds: 120,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      image_url: r.image,
      duration: `${duration}s`,
      resolution,
      aspect_ratio: 'auto',
      generate_audio: false,
      ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
      ...seed(r),
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/wan-25-preview/image-to-video',
    name: 'Wan 2.5',
    task: 'image-to-video',
    tier: 'quality',
    description: 'Good value at 720p, 5 or 10 seconds.',
    durations: [5, 10],
    defaultDuration: 5,
    usdPerSecond: { '480p': 0.05, '720p': 0.1, '1080p': 0.15 },
    resolutions: [
      { id: '480p', label: '480p' },
      { id: '720p', label: '720p' },
      { id: '1080p', label: '1080p' },
    ],
    defaultResolution: '720p',
    typicalSeconds: 150,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      image_url: r.image,
      duration: String(duration),
      resolution,
      enable_safety_checker: true,
      ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
      ...seed(r),
    }),
  }),

  // Text to video
  perSecondVideoModel({
    id: 'minimax/h3-max-turbo/text-to-video',
    name: 'MiniMax H3 Max Turbo',
    task: 'text-to-video',
    tier: 'draft',
    description: 'Fast, affordable clips from a prompt. Any length up to 15 s.',
    durations: { min: 1, max: 15 },
    defaultDuration: 5,
    usdPerSecond: { '480P': 0.025, '768P': 0.04, '1080P': 0.08 },
    resolutions: [
      { id: '480P', label: '480p' },
      { id: '768P', label: '768p' },
      { id: '1080P', label: '1080p' },
    ],
    defaultResolution: '768P',
    typicalSeconds: 90,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      duration,
      resolution,
      aspect_ratio: aspectFor(r.aspect, ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
      prompt_expansion_mode: 'balanced',
      enable_safety_checker: true,
      ...seed(r),
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/kling-video/v3/pro/text-to-video',
    name: 'Kling 3 Pro',
    task: 'text-to-video',
    tier: 'quality',
    description: 'Cinematic clips from a prompt, 3 to 15 seconds.',
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    usdPerSecond: { default: 0.112 },
    resolutions: [{ id: 'default', label: 'Standard' }],
    defaultResolution: 'default',
    typicalSeconds: 180,
    input: (r, duration) => ({
      prompt: r.prompt,
      duration: String(duration),
      aspect_ratio: aspectFor(r.aspect, ['16:9', '9:16', '1:1']),
      generate_audio: false,
      enable_safety_checker: true,
      ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
    }),
  }),
  perSecondVideoModel({
    id: 'fal-ai/wan-25-preview/text-to-video',
    name: 'Wan 2.5',
    task: 'text-to-video',
    tier: 'quality',
    description: 'Good value at 720p, 5 or 10 seconds.',
    durations: [5, 10],
    defaultDuration: 5,
    usdPerSecond: { '480p': 0.05, '720p': 0.1, '1080p': 0.15 },
    resolutions: [
      { id: '480p', label: '480p' },
      { id: '720p', label: '720p' },
      { id: '1080p', label: '1080p' },
    ],
    defaultResolution: '720p',
    typicalSeconds: 150,
    input: (r, duration, resolution) => ({
      prompt: r.prompt,
      duration: String(duration),
      resolution,
      aspect_ratio: aspectFor(r.aspect, ['16:9', '9:16', '1:1']),
      enable_safety_checker: true,
      ...(r.negativePrompt ? { negative_prompt: r.negativePrompt } : {}),
      ...seed(r),
    }),
  }),
]

/** The model picked when the user has not chosen one, per task and tier. */
export const DEFAULT_FAL_MODELS: Record<GenerationModel['task'], Record<'draft' | 'quality', string>> = {
  'text-to-image': { draft: 'fal-ai/flux/schnell', quality: 'fal-ai/flux-2-pro' },
  'image-to-video': {
    draft: 'minimax/h3-max-turbo/image-to-video',
    quality: 'fal-ai/kling-video/v3/pro/image-to-video',
  },
  'text-to-video': {
    draft: 'minimax/h3-max-turbo/text-to-video',
    quality: 'fal-ai/kling-video/v3/pro/text-to-video',
  },
}

export function falModel(id: string): FalModel | undefined {
  return FAL_MODELS.find((m) => m.id === id)
}
