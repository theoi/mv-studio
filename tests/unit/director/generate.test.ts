import { describe, expect, it } from 'vitest'
import {
  buildPlannerInput,
  estimatePlanCost,
  generatePlanShots,
  generationOptionsFor,
  planLocally,
  requiresConfirmation,
  shotsToGenerate,
} from '../../../src/director/index.ts'
import { CloudError } from '../../../src/cloud/errors.ts'
import type { Asset, Project } from '../../../src/model/types.ts'
import { badKey, contentPolicy, fakeProvider, makeProject, memoryStore, testCtx } from './fixtures.ts'

async function aiPlan(mode: 'images' | 'video' = 'images', maxShots?: number) {
  const provider = fakeProvider()
  const project = makeProject({ videos: 0 })
  const generation = generationOptionsFor(provider, { mode, tier: 'draft', maxShots })!
  const plan = await planLocally(await buildPlannerInput(project, { kind: 'ai', seed: 2, generation }))
  return { provider, project, plan }
}

describe('estimatePlanCost by model', () => {
  it('groups draft images under the provider’s name for their model', async () => {
    const { provider, project, plan } = await aiPlan('images')
    const cost = estimatePlanCost(plan, provider, project)
    expect(cost.count).toBeGreaterThan(1)
    expect(cost.byModel).toEqual([
      {
        modelId: cost.requests[0]!.request.modelId,
        name: provider.getModel(cost.requests[0]!.request.modelId)!.name,
        kind: 'image',
        count: cost.count,
        usd: cost.usd,
      },
    ])
    expect(cost.byModel[0]!.name).not.toBe(cost.byModel[0]!.modelId)
  })

  it('counts clips apart from images, the most expensive model first, adding up to the whole cost', async () => {
    const { provider, project, plan } = await aiPlan('video')
    const cost = estimatePlanCost(plan, provider, project)
    expect(cost.byModel.some((m) => m.kind === 'clip')).toBe(true)
    expect(cost.byModel.reduce((n, m) => n + m.count, 0)).toBe(cost.count)
    expect(cost.byModel.reduce((usd, m) => usd + m.usd, 0)).toBeCloseTo(cost.usd, 4)
    expect(cost.byModel.map((m) => m.usd)).toEqual(cost.byModel.map((m) => m.usd).sort((a, b) => b - a))
  })
})

describe('generatePlanShots', () => {
  it('generates each paid shot once, never the reused ones, and reports every result', async () => {
    const { provider, project, plan } = await aiPlan()
    const store = memoryStore()
    const reported: string[] = []
    const result = await generatePlanShots({
      plan,
      provider,
      store,
      project,
      ctx: testCtx(),
      onShot: (shotId) => reported.push(shotId),
    })
    const paid = shotsToGenerate(plan)
    expect(provider.calls).toHaveLength(paid.length)
    expect(new Set(provider.calls.map((c) => c.prompt))).toEqual(new Set(paid.map((s) => s.source.prompt)))
    expect([...result.assets.keys()].sort()).toEqual(paid.map((s) => s.id).sort())
    expect(reported.sort()).toEqual(paid.map((s) => s.id).sort())
    expect(store.stored).toHaveLength(paid.length)
    expect(result.spentUsd).toBeCloseTo(estimatePlanCost(plan, provider).usd, 6)
  })

  it('reuses media already generated from the same request at no cost', async () => {
    const { provider, project, plan } = await aiPlan()
    const first = shotsToGenerate(plan)[0]!
    const existing: Asset = {
      id: 'earlier',
      kind: 'image',
      name: 'AI image',
      mimeType: 'image/jpeg',
      byteSize: 1,
      storageKey: 'media/earlier',
      origin: { type: 'generated', provider: first.source.modelId, prompt: first.source.prompt },
      createdAt: new Date(0).toISOString(),
    }
    const withAsset: Project = { ...project, assets: { ...project.assets, earlier: existing } }
    const cost = estimatePlanCost(plan, provider, withAsset)
    expect(cost.reused).toBe(1)
    expect(cost.count).toBe(shotsToGenerate(plan).length - 1)
    const result = await generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project: withAsset,
      ctx: testCtx(),
    })
    expect(provider.calls).toHaveLength(shotsToGenerate(plan).length - 1)
    expect(result.assets.get(first.id)?.id).toBe('earlier')
  })

  it('skips shots that already have results', async () => {
    const { provider, project, plan } = await aiPlan()
    const [a] = shotsToGenerate(plan)
    const done = new Map<string, Asset>([[a!.id, { id: 'x' } as Asset]])
    const result = await generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project,
      done,
      ctx: testCtx(),
    })
    expect(provider.calls).toHaveLength(shotsToGenerate(plan).length - 1)
    expect(result.assets.get(a!.id)?.id).toBe('x')
  })

  it('stops at the first key error instead of failing every shot', async () => {
    const { project, plan } = await aiPlan()
    const provider = fakeProvider({ failOn: () => badKey() })
    const error = await generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project,
      ctx: testCtx(),
      concurrency: 1,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudError)
    expect((error as CloudError).kind).toBe('bad-key')
    expect(provider.calls).toHaveLength(1)
  })

  it('keeps going when one prompt is blocked and lists the failure', async () => {
    const { project, plan } = await aiPlan()
    const provider = fakeProvider({ failOn: (i) => (i === 1 ? contentPolicy() : undefined) })
    const result = await generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project,
      ctx: testCtx(),
      concurrency: 1,
    })
    const paid = shotsToGenerate(plan)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.error.message).toBe('Prompt was blocked')
    expect(result.assets.size).toBe(paid.length - 1)
  })

  it('asks for a video length that fits each shot', async () => {
    const { provider, project, plan } = await aiPlan('video', 4)
    await generatePlanShots({ plan, provider, store: memoryStore(), project, ctx: testCtx() })
    const shots = shotsToGenerate(plan)
    for (const [i, call] of provider.calls.entries()) {
      expect(call.task).toBe('text-to-video')
      const shot = shots.find(
        (s) => s.source.prompt === call.prompt && Math.abs((call.duration ?? 0) - (s.end - s.start)) < 0.11,
      )
      expect(shot, `call ${i}`).toBeDefined()
    }
  })
})

describe('requiresConfirmation', () => {
  const policy = { alwaysConfirmPaid: false, confirmAboveUsd: 1, monthlyReminderUsd: 10 }
  it('asks above the threshold, when crossing the monthly reminder, or always when set', () => {
    expect(requiresConfirmation(0.5, policy)).toBe(false)
    expect(requiresConfirmation(1.5, policy)).toBe(true)
    expect(requiresConfirmation(0.5, { ...policy, alwaysConfirmPaid: true })).toBe(true)
    expect(requiresConfirmation(0.5, policy, { crossesReminder: () => true })).toBe(true)
    expect(requiresConfirmation(0, { ...policy, alwaysConfirmPaid: true })).toBe(false)
  })
})
