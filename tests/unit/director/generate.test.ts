import { describe, expect, it, vi } from 'vitest'
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
import { FalProvider } from '../../../src/cloud/fal/provider.ts'
import { PAID_RESULT_GRACE_MS } from '../../../src/cloud/media.ts'
import type { Asset, Project } from '../../../src/model/types.ts'
import { JobError, type JobProgress } from '../../../src/shared/jobs.ts'
import { browserFetch } from '../cloud/mocks/browser.ts'
import { FAL_TEST_KEY, MockFalServer } from '../cloud/mocks/fal-server.ts'
import { badKey, contentPolicy, fakeProvider, makeProject, memoryStore, testCtx } from './fixtures.ts'

async function aiPlan(mode: 'images' | 'video' = 'images', maxShots?: number) {
  const provider = fakeProvider()
  const project = makeProject({ videos: 0 })
  const generation = generationOptionsFor(provider, { mode, tier: 'draft', maxShots })!
  const plan = await planLocally(await buildPlannerInput(project, { kind: 'ai', seed: 2, generation }))
  return { provider, project, plan }
}

/** Lets queued promise callbacks run until `done()` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(done()).toBe(true)
}

describe('estimatePlanCost by model', () => {
  it('groups draft images under the provider’s name for their model', async () => {
    const { provider, project, plan } = await aiPlan('images')
    const cost = estimatePlanCost(plan, provider, project)
    expect(cost.count).toBeGreaterThan(1)
    const modelId = cost.requests[0]!.request.modelId
    expect(cost.byModel).toEqual([
      { name: provider.getModel(modelId)!.name, kind: 'image', count: cost.count, usd: cost.usd },
    ])
    expect(cost.byModel[0]!.name).not.toBe(modelId)
  })

  it('puts a model’s text-to-video and image-to-video endpoints on one line', async () => {
    const { provider, project, plan } = await aiPlan('video')
    let n = 0
    const kling = {
      ...plan,
      shots: plan.shots.map((s) => {
        if (s.source.type !== 'generate' || s.source.task === 'text-to-image') return s
        const task = n++ % 2 ? ('image-to-video' as const) : ('text-to-video' as const)
        return { ...s, source: { ...s.source, task, modelId: `fal-ai/kling-video/v3/pro/${task}` } }
      }),
    }
    const cost = estimatePlanCost(kling, provider, project)
    expect(new Set(cost.requests.map((r) => r.request.modelId)).size).toBe(2)
    expect(cost.byModel).toEqual([
      {
        name: 'Kling 3 Pro',
        kind: 'clip',
        count: cost.count,
        usd: expect.closeTo(cost.usd, 2) as number,
        seconds: expect.any(Number) as number,
      },
    ])
  })

  it('prices clips by the second at the lengths the model makes, and adds up their seconds', async () => {
    const { provider, project, plan } = await aiPlan('video', 3)
    // MiniMax H3 Max Turbo makes any length to a tenth of a second, at $0.04 a second at its default 768p.
    const sized = {
      ...plan,
      shots: plan.shots.map((s) =>
        s.source.type === 'generate' ? { ...s, source: { ...s.source, duration: 4.21 } } : s,
      ),
    }
    const cost = estimatePlanCost(sized, provider, project)
    expect(cost.count).toBe(3)
    expect(cost.byModel).toEqual([
      {
        name: 'MiniMax H3 Max Turbo',
        kind: 'clip',
        count: 3,
        usd: expect.closeTo(3 * 4.3 * 0.04, 3) as number,
        seconds: 12.9,
      },
    ])
    expect(cost.usd).toBeCloseTo(3 * 4.3 * 0.04, 3)
  })

  it('counts clips apart from images, the most expensive model first, adding up to the whole cost', async () => {
    const images = await aiPlan('images')
    const { provider, project, plan } = await aiPlan('video')
    const imageSource = shotsToGenerate(images.plan)[0]!.source
    let n = 0
    // Every other clip becomes a still, starting with the first, so the cheaper images come first in the plan.
    const mixed = {
      ...plan,
      shots: plan.shots.map((s) =>
        s.source.type === 'generate' && n++ % 2 === 0
          ? { ...s, source: { ...imageSource, prompt: s.source.prompt } }
          : s,
      ),
    }
    const cost = estimatePlanCost(mixed, provider, project)
    expect(cost.byModel.map((m) => m.kind)).toEqual(['clip', 'image'])
    expect(cost.byModel.reduce((n, m) => n + m.count, 0)).toBe(cost.count)
    expect(cost.byModel.reduce((usd, m) => usd + m.usd, 0)).toBeCloseTo(cost.usd, 4)
    expect(cost.byModel[0]!.usd).toBeGreaterThan(cost.byModel[1]!.usd)
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

  it('asks for each video as long as the longest shot that shows it', async () => {
    const { provider, project, plan } = await aiPlan('video', 4)
    const length = (s: { start: number; end: number }) => s.end - s.start
    const showing = (id: string) =>
      plan.shots.filter((s) => s.id === id || (s.source.type === 'generate' && s.source.sameAs === id))
    const shots = shotsToGenerate(plan)
    // Some clip is reused in a shot longer than its own, so its own length would run out.
    expect(shots.some((s) => showing(s.id).some((r) => length(r) > length(s) + 0.2))).toBe(true)
    await generatePlanShots({ plan, provider, store: memoryStore(), project, ctx: testCtx() })
    expect(provider.calls).toHaveLength(shots.length)
    for (const shot of shots) {
      const call = provider.calls.find(
        (c) =>
          c.prompt === shot.source.prompt &&
          c.task === 'text-to-video' &&
          Math.abs((c.duration ?? 0) - Math.max(...showing(shot.id).map(length))) < 0.01,
      )
      expect(call, shot.label).toBeDefined()
    }
  })

  it('counts images as shots, without a time estimate', async () => {
    const { project, plan } = await aiPlan('images', 3)
    const provider = fakeProvider({
      gate: (_, ctx) => {
        ctx.progress({ stage: 'generate', fraction: 0.5, etaSeconds: 2, message: 'Generating, usually 3 s' })
        return Promise.resolve()
      },
    })
    const events: JobProgress[] = []
    await generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project,
      ctx: { ...testCtx(), progress: (p) => events.push(p) },
    })
    expect(events.length).toBeGreaterThan(3)
    expect(events[0]?.message).toBe('Generating shot 1 of 3')
    expect(events.filter((e) => e.etaSeconds !== undefined)).toEqual([])
  })

  it('moves the bar while each clip is made, counts clips as they finish, and says how long is left', async () => {
    const { project, plan } = await aiPlan('video', 3)
    const release: (() => void)[] = []
    const provider = fakeProvider({
      gate: (_, ctx) => {
        ctx.progress({
          stage: 'generate',
          fraction: 0.5,
          etaSeconds: 40,
          message: 'Generating, usually 1 min 30 s',
        })
        return new Promise<void>((resolve) => release.push(resolve))
      },
    })
    const events: JobProgress[] = []
    const counts: { done: number; failed: number; total: number }[] = []
    const run = generatePlanShots({
      plan,
      provider,
      store: memoryStore(),
      project,
      ctx: { ...testCtx(), progress: (p) => events.push(p) },
      onProgress: (c) => counts.push(c),
    })
    const total = shotsToGenerate(plan).length
    expect(total).toBe(3)
    await until(() => release.length === 2)
    // Two clips half made: a third of the bar. Left: the longer of their 40 s, then the third clip's usual 90 s
    // shared by the two requests at a time.
    expect(events.at(-1)).toEqual({
      stage: 'generate',
      fraction: expect.closeTo(1 / 3, 5) as number,
      message: 'Generating clip 1 of 3',
      etaSeconds: 85,
    })
    expect(counts).toEqual([])
    release[0]!()
    await until(() => counts.length === 1)
    expect(counts).toEqual([{ done: 1, failed: 0, total: 3 }])
    expect(events.at(-1)?.message).toBe('Generating clip 2 of 3')
    await until(() => release.length === 3)
    release[1]!()
    release[2]!()
    await run
    expect(counts.at(-1)).toEqual({ done: 3, failed: 0, total: 3 })
    const fractions = events.map((e) => e.fraction ?? 0)
    expect(fractions.at(-1)).toBe(1)
    expect(fractions.every((f, i) => i === 0 || f >= (fractions[i - 1] as number))).toBe(true)
  })

  it('keeps clips fal.ai finished when Cancel lands during their download, and asks for no more', async () => {
    const { project, plan } = await aiPlan('video', 3)
    const release: (() => void)[] = []
    const provider = fakeProvider({
      gate: (_, ctx) => {
        ctx.progress({ stage: 'download', fraction: 0.92, message: 'Downloading the video' })
        return new Promise<void>((resolve) => release.push(resolve))
      },
    })
    const controller = new AbortController()
    const ctx = testCtx(controller.signal)
    const store = memoryStore()
    const kept: string[] = []
    const billed: number[] = []
    let settled = false
    const outcome = generatePlanShots({
      plan,
      provider,
      store,
      project,
      ctx,
      onShot: (shotId) => kept.push(shotId),
      onBilled: (usd) => billed.push(usd),
    })
      .catch((e: unknown) => e)
      .finally(() => (settled = true))
    await until(() => release.length === 2)
    controller.abort()
    expect(ctx.updates.at(-1)).toBe('Stopping… keeping 2 clips that are downloading')
    release[0]!()
    await until(() => kept.length === 1)
    // The other clip is still downloading, so the run waits for it instead of ending at the cancel.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(ctx.updates.at(-1)).toBe('Stopping… keeping 1 clip that is downloading')
    release[1]!()
    const error = await outcome
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).code).toBe('cancelled')
    expect(kept).toHaveLength(2)
    expect(store.stored).toHaveLength(2)
    expect(provider.calls).toHaveLength(2)
    expect(billed).toEqual(provider.calls.map((c) => provider.estimate(c).usd))
  })

  it('gives up on a download still stalled 30 s after Cancel, and still counts what fal.ai billed', async () => {
    const { project, plan } = await aiPlan('video', 3)
    const provider = fakeProvider({
      gate: (_, ctx) => {
        ctx.progress({ stage: 'download', fraction: 0.92, message: 'Downloading the video' })
        return new Promise<void>(() => undefined)
      },
    })
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const kept: string[] = []
      const billed: number[] = []
      let settled = false
      const outcome = generatePlanShots({
        plan,
        provider,
        store: memoryStore(),
        project,
        ctx: testCtx(controller.signal),
        onShot: (shotId) => kept.push(shotId),
        onBilled: (usd) => billed.push(usd),
        concurrency: 1,
      })
        .catch((e: unknown) => e)
        .finally(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(provider.calls).toHaveLength(1)
      controller.abort()
      await vi.advanceTimersByTimeAsync(PAID_RESULT_GRACE_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(((await outcome) as JobError).code).toBe('cancelled')
      expect(kept).toEqual([])
      expect(provider.calls).toHaveLength(1)
      expect(billed).toEqual([provider.estimate(provider.calls[0]!).usd])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a clip fal.ai finished when Cancel lands while its result is fetched', async () => {
    const { project, plan } = await aiPlan('video', 3)
    const server = new MockFalServer()
    const servers = server.servers()
    const queue = servers['https://queue.fal.run']!
    const held: (() => void)[] = []
    // fal.ai has billed the request once it says COMPLETED; the result fetch after that is held here.
    servers['https://queue.fal.run'] = async (request) => {
      if (request.method === 'GET' && /\/requests\/[^/]+$/.test(new URL(request.url).pathname))
        await new Promise<void>((resolve) => held.push(resolve))
      return queue(request)
    }
    const fal = new FalProvider({
      getKey: () => FAL_TEST_KEY,
      fetch: browserFetch(servers).fetch,
      pollIntervalMs: 1,
    })
    const url = server.file('clip.mp4', new Blob(['mp4'], { type: 'video/mp4' }))
    for (const shot of shotsToGenerate(plan)) {
      if (shot.source.type !== 'generate') continue
      server.script(shot.source.modelId, {
        statuses: ['COMPLETED'],
        result: { video: { url, content_type: 'video/mp4' } },
      })
    }
    const controller = new AbortController()
    const kept: string[] = []
    const billed: number[] = []
    const outcome = generatePlanShots({
      plan,
      provider: fal,
      store: memoryStore(),
      project,
      ctx: testCtx(controller.signal),
      onShot: (shotId) => kept.push(shotId),
      onBilled: (usd) => billed.push(usd),
      concurrency: 1,
    }).catch((e: unknown) => e)
    await until(() => held.length === 1)
    controller.abort()
    held[0]!()
    expect(((await outcome) as JobError).code).toBe('cancelled')
    expect(kept).toHaveLength(1)
    expect(billed).toHaveLength(1)
    expect(server.queued.size).toBe(1)
    expect([...server.queued.values()].some((q) => q.cancelled)).toBe(false)
  })
  it.each([
    {
      what: 'fal.ai fails the request itself (500 from the result)',
      resultStatus: 500,
      fileStatus: 200,
      charged: false,
    },
    {
      what: 'fal.ai may still charge (422 from the result)',
      resultStatus: 422,
      fileStatus: 200,
      charged: true,
    },
    { what: 'the file host fails the download (500)', resultStatus: 200, fileStatus: 500, charged: true },
  ])('counts a clip that fails after COMPLETED only if fal.ai charges for it: $what', async (c) => {
    const { project, plan } = await aiPlan('video', 2)
    const server = new MockFalServer()
    const servers = server.servers()
    const media = servers['https://v3.fal.media']!
    servers['https://v3.fal.media'] = async (request) =>
      c.fileStatus === 200 ? media(request) : new Response('', { status: c.fileStatus })
    const fal = new FalProvider({
      getKey: () => FAL_TEST_KEY,
      fetch: browserFetch(servers).fetch,
      pollIntervalMs: 1,
    })
    const url = server.file('clip.mp4', new Blob(['mp4'], { type: 'video/mp4' }))
    for (const shot of shotsToGenerate(plan)) {
      if (shot.source.type !== 'generate') continue
      server.script(shot.source.modelId, {
        statuses: ['COMPLETED'],
        result: { video: { url, content_type: 'video/mp4' } },
        ...(c.resultStatus === 200
          ? {}
          : { resultError: { status: c.resultStatus, body: { detail: 'Something went wrong' } } }),
      })
    }
    const billed: number[] = []
    const error = await generatePlanShots({
      plan,
      provider: fal,
      store: memoryStore(),
      project,
      ctx: testCtx(),
      onBilled: (usd) => billed.push(usd),
      concurrency: 1,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CloudError)
    expect(server.queued.size).toBeGreaterThan(0)
    expect(billed).toHaveLength(c.charged ? server.queued.size : 0)
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
