import { describe, expect, it } from 'vitest'
import { DEFAULT_FAL_MODELS, FAL_MODELS, falModel, snapDuration } from '../../../src/cloud/fal/catalog.ts'
import type { GenerationRequest } from '../../../src/cloud/types.ts'

const est = (r: Omit<GenerationRequest, 'prompt'>) => falModel(r.modelId)!.estimate({ prompt: 'p', ...r }).usd

describe('fal.ai price table', () => {
  it('bills image models per rounded-up megapixel', () => {
    expect(est({ task: 'text-to-image', modelId: 'fal-ai/flux/schnell', aspect: '16:9' })).toBe(0.003)
    expect(est({ task: 'text-to-image', modelId: 'fal-ai/z-image/turbo', aspect: '9:16' })).toBe(0.005)
    expect(est({ task: 'text-to-image', modelId: 'fal-ai/flux-2-pro', aspect: '16:9' })).toBe(0.045)
    expect(
      est({ task: 'text-to-image', modelId: 'fal-ai/bytedance/seedream/v4.5/text-to-image', aspect: '1:1' }),
    ).toBe(0.04)
  })

  it('bills video per second at the chosen resolution, after snapping the length', () => {
    expect(
      est({
        task: 'image-to-video',
        modelId: 'minimax/h3-max-turbo/image-to-video',
        aspect: '16:9',
        duration: 5,
      }),
    ).toBeCloseTo(0.2)
    expect(
      est({
        task: 'image-to-video',
        modelId: 'minimax/h3-max-turbo/image-to-video',
        aspect: '16:9',
        duration: 5,
        resolution: '480P',
      }),
    ).toBeCloseTo(0.125)
    expect(
      est({
        task: 'image-to-video',
        modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
        aspect: '16:9',
        duration: 7,
      }),
    ).toBeCloseTo(0.45)
    expect(
      est({
        task: 'image-to-video',
        modelId: 'fal-ai/veo3.1/fast/image-to-video',
        aspect: '16:9',
        duration: 5,
      }),
    ).toBeCloseTo(0.6)
    expect(
      est({
        task: 'text-to-video',
        modelId: 'fal-ai/kling-video/v3/pro/text-to-video',
        aspect: '16:9',
        duration: 5,
      }),
    ).toBeCloseTo(0.56)
    expect(
      est({
        task: 'text-to-video',
        modelId: 'fal-ai/wan-25-preview/text-to-video',
        aspect: '16:9',
        duration: 10,
      }),
    ).toBeCloseTo(1.0)
  })

  it('snaps durations up to the next supported length and clamps to the range', () => {
    const hailuo = falModel('fal-ai/minimax/hailuo-02/standard/image-to-video')!
    expect(snapDuration(hailuo, 3)).toBe(6)
    expect(snapDuration(hailuo, 30)).toBe(10)
    const h3 = falModel('minimax/h3-max-turbo/text-to-video')!
    expect(snapDuration(h3, 3.33)).toBe(3.4)
    expect(snapDuration(h3, 40)).toBe(15)
  })

  it('puts the image URL in each image-to-video model’s documented field', () => {
    const i2v = FAL_MODELS.filter((m) => m.task === 'image-to-video')
    expect(i2v.length).toBeGreaterThan(0)
    for (const model of i2v) {
      const input = model.buildInput({
        task: 'image-to-video',
        modelId: model.id,
        prompt: 'move',
        aspect: '16:9',
        image: 'https://img',
      })
      const field = model.id.includes('kling') ? 'start_image_url' : 'image_url'
      expect(input[field], model.id).toBe('https://img')
      expect(input.prompt).toBe('move')
    }
  })

  it('maps project aspects to the closest ratio a text-to-video model accepts', () => {
    const h3 = falModel('minimax/h3-max-turbo/text-to-video')!
    const kling = falModel('fal-ai/kling-video/v3/pro/text-to-video')!
    const req = { task: 'text-to-video' as const, prompt: 'x', aspect: '4:5' as const }
    expect(h3.buildInput({ ...req, modelId: h3.id }).aspect_ratio).toBe('3:4')
    expect(kling.buildInput({ ...req, modelId: kling.id }).aspect_ratio).toBe('1:1')
    expect(h3.buildInput({ ...req, modelId: h3.id }).prompt_expansion_mode).toBe('balanced')
  })

  it('only lists defaults that exist with the right task', () => {
    for (const [task, tiers] of Object.entries(DEFAULT_FAL_MODELS)) {
      for (const id of Object.values(tiers)) expect(falModel(id)?.task, id).toBe(task)
    }
  })
})
