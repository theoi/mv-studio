import { describe, expect, it, vi } from 'vitest'
import { CloudError } from '../../../src/cloud/errors.ts'
import { SpendLedger } from '../../../src/cloud/spend.ts'
import { MemoryStorage } from '../../../src/cloud/keys.ts'
import {
  DirectorError,
  DirectorSession,
  directorMeta,
  type DirectorState,
  type Planner,
} from '../../../src/director/index.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import { badKey, fakeProvider, makeProject, memoryStore, type FakeProvider } from './fixtures.ts'

function setup(o: { provider?: FakeProvider; videos?: number; confirmAboveUsd?: number } = {}) {
  const project = makeProject({ videos: o.videos ?? 4 })
  const editor = new ProjectEditor(project)
  const ledger = new SpendLedger({ storage: new MemoryStorage(), now: () => new Date(0) })
  const store = memoryStore()
  const session = new DirectorSession({
    editor,
    jobs: new JobRunner(),
    provider: o.provider ? () => o.provider : undefined,
    store,
    ledger,
    spendPolicy: () => ({
      alwaysConfirmPaid: false,
      confirmAboveUsd: o.confirmAboveUsd ?? 1,
      monthlyReminderUsd: 0,
    }),
  })
  const states: DirectorState['status'][] = []
  session.subscribe(() => {
    const status = session.getState().status
    if (states[states.length - 1] !== status) states.push(status)
  })
  return { project, editor, session, ledger, store, states }
}

/** A server error: the shot fails, the others keep going. */
const providerDown = () =>
  new CloudError({
    kind: 'server',
    provider: 'fal',
    title: 'fal.ai had a problem',
    message: 'HTTP 500',
    status: 500,
  })

function ready(state: DirectorState) {
  if (state.status !== 'ready') throw new Error(`expected ready, got ${state.status}`)
  return state
}

describe('DirectorSession', () => {
  it('plans, previews, applies as one undo step, and undoes back to the plan', async () => {
    const { project, editor, session, states } = setup()
    const planned = ready(await session.plan({ kind: 'beat-cut', seed: 4 }))
    expect(planned.cost).toBeNull()
    expect(planned.actionLabel).toBe('Make video')
    expect(planned.preview.changes).toMatch(/^Adds \d+ clips and 2 tracks\.$/)
    expect(editor.getProject()).toBe(project)

    const applied = await session.apply()
    expect(applied.status).toBe('applied')
    const after = editor.getProject()
    expect(Object.values(after.clips).filter((c) => directorMeta(c)?.role === 'shots')).toHaveLength(
      planned.plan.shots.length,
    )
    expect(states).toEqual(['planning', 'ready', 'applied'])

    expect(session.undo()).toBe(true)
    expect(editor.getProject()).toEqual(project)
    expect(session.getState().status).toBe('ready')
  })

  it('does not undo a change the user made after applying', async () => {
    const { editor, session } = setup()
    await session.plan({ kind: 'beat-cut' })
    await session.apply()
    editor.dispatch({ type: 'project.rename', name: 'Mine' })
    expect(session.undo()).toBe(false)
    expect(editor.getProject().name).toBe('Mine')
  })

  it('shows the cost and refuses to spend above the threshold without confirmation', async () => {
    const provider = fakeProvider()
    const { session, ledger } = setup({ provider, videos: 0, confirmAboveUsd: 0.01 })
    const planned = ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    expect(planned.cost?.count).toBeGreaterThan(0)
    expect(planned.confirmRequired).toBe(true)
    expect(planned.actionLabel).toMatch(/^Generate \d+ shots · about \$0\.\d\d$/)

    const refused = await session.apply().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(DirectorError)
    expect((refused as DirectorError).reason).toBe('needs-confirmation')
    expect(provider.calls).toHaveLength(0)

    const applied = await session.apply({ confirmSpend: true })
    expect(applied.status).toBe('applied')
    expect(provider.calls).toHaveLength(planned.cost!.count)
    expect(ledger.monthTotal()).toBeCloseTo(planned.cost!.usd, 4)
  })

  it('generates without asking when the estimate is under the threshold', async () => {
    const provider = fakeProvider()
    const { session, editor } = setup({ provider, videos: 0, confirmAboveUsd: 5 })
    const planned = ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    expect(planned.confirmRequired).toBe(false)
    await session.apply()
    const images = Object.values(editor.getProject().clips).filter((c) => c.type === 'image')
    expect(images).toHaveLength(planned.plan.shots.length)
  })

  it('keeps shots generated before a cancel and does not pay for them again', async () => {
    // The first two requests finish; the rest wait until the user cancels.
    const provider = fakeProvider({
      gate: (i) => (i < 2 ? Promise.resolve() : new Promise<void>(() => undefined)),
    })
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 5 })
    const planned = ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    const total = planned.cost!.count
    const applying = session.apply()
    await new Promise((r) => setTimeout(r, 0))
    expect(session.getState().status).toBe('generating')
    session.cancel()
    const after = ready(await applying)
    expect(after.preview.warnings.some((w) => w.startsWith('Generation stopped.'))).toBe(true)
    const kept = after.generatedShots
    expect(kept).toBe(2)
    expect(after.cost?.count).toBe(total - kept)

    provider.gate = undefined
    const callsBefore = provider.calls.length
    expect((await session.apply({ confirmSpend: true })).status).toBe('applied')
    expect(provider.calls.length - callsBefore).toBe(total - kept)
  })

  it('keeps paid shots in the project after undo, and reuses them instead of paying again', async () => {
    const provider = fakeProvider()
    const { session, editor } = setup({ provider, videos: 0, confirmAboveUsd: 5 })
    const request = {
      kind: 'ai' as const,
      seed: 3,
      generate: { mode: 'images' as const, tier: 'draft' as const },
    }
    const planned = ready(await session.plan(request))
    const paid = planned.cost!.count
    expect((await session.apply()).status).toBe('applied')
    expect(provider.calls).toHaveLength(paid)
    const generatedAssets = () =>
      Object.values(editor.getProject().assets).filter((a) => a.origin.type === 'generated').length

    expect(session.undo()).toBe(true)
    const undone = ready(session.getState())
    expect(undone.generatedShots).toBe(paid)
    expect(undone.actionLabel).toBe('Make video')
    expect(generatedAssets()).toBe(paid)
    expect((await session.apply()).status).toBe('applied')
    expect(provider.calls).toHaveLength(paid)

    session.undo()
    session.reset()
    const again = ready(await session.plan(request))
    expect(again.cost?.count ?? 0).toBe(0)
    expect((await session.apply()).status).toBe('applied')
    expect(provider.calls).toHaveLength(paid)
  })

  it('prices a retry of failed shots and asks first when the policy says so', async () => {
    const provider = fakeProvider({ failOn: (i) => (i < 2 ? providerDown() : undefined) })
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 0.001 })
    ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    const applied = await session.apply({ confirmSpend: true })
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`)
    expect(applied.failedShots).toBe(2)
    expect(applied.cost?.count).toBe(2)
    expect(applied.confirmRequired).toBe(true)
    const calls = provider.calls.length
    const refused = await session.apply().catch((e: unknown) => e)
    expect((refused as DirectorError).reason).toBe('needs-confirmation')
    expect(provider.calls).toHaveLength(calls)
  })

  it('goes back from a failed generation to the plan with its price', async () => {
    const provider = fakeProvider({ failOn: () => providerDown() })
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 0.001 })
    const planned = ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    const failed = await session.apply({ confirmSpend: true })
    if (failed.status !== 'error') throw new Error(`expected error, got ${failed.status}`)
    expect(failed.cost?.count).toBe(planned.cost!.count)
    expect(failed.confirmRequired).toBe(true)
    expect(failed.generatedShots).toBe(0)
    const back = ready(session.backToPlan())
    expect(back.plan.id).toBe(planned.plan.id)
    expect(back.actionLabel).toBe(planned.actionLabel)
  })

  it('applies with placeholders when asked to skip generation', async () => {
    const provider = fakeProvider()
    const { session, editor } = setup({ provider, videos: 0 })
    await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } })
    const applied = await session.apply({ skipGeneration: true })
    expect(applied.status).toBe('applied')
    expect(provider.calls).toHaveLength(0)
    const placeholders = Object.values(editor.getProject().clips).filter((c) => directorMeta(c)?.pending)
    expect(placeholders.length).toBeGreaterThan(0)
  })

  it('shows the provider error with its steps and keeps the plan', async () => {
    const provider = fakeProvider({ failOn: () => badKey() })
    const { session, editor, project } = setup({ provider, videos: 0, confirmAboveUsd: 5 })
    await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } })
    const state = await session.apply()
    if (state.status !== 'error') throw new Error(`expected error, got ${state.status}`)
    expect(state.title).toBe('fal.ai rejected the key')
    expect(state.plan).toBeDefined()
    expect(editor.getProject()).toBe(project)
  })

  it('explains a missing song as an error state', async () => {
    const { session, editor } = setup()
    editor.dispatch({ type: 'project.setSong', assetId: null })
    const state = await session.plan({ kind: 'lyric' })
    if (state.status !== 'error') throw new Error(`expected error, got ${state.status}`)
    expect(state.message).toMatch(/Add a song first/)
  })
})

describe('DirectorSession with an AI planner', () => {
  it('offers the local draft while the AI model is slow, and uses it on request', async () => {
    const editor = new ProjectEditor(makeProject())
    const slowPlanner: Planner = (_input, ctx) => {
      ctx.progress({ stage: 'llm', message: 'Asking your AI model for ideas' })
      return new Promise((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled'))),
      )
    }
    const session = new DirectorSession({
      editor,
      jobs: new JobRunner(),
      planner: slowPlanner,
      slowAfterMs: 5,
    })
    const before = Date.now()
    const first = session.plan({ kind: 'beat-cut', seed: 1 })
    expect(session.getState()).toMatchObject({ status: 'planning', slow: false, canUseLocal: true })
    expect((session.getState() as { startedAt: number }).startedAt).toBeGreaterThanOrEqual(before)
    await vi.waitFor(() =>
      expect(session.getState()).toMatchObject({
        status: 'planning',
        slow: true,
        message: 'Asking your AI model for ideas',
      }),
    )
    const local = ready(await session.useLocalDraft())
    expect(local.plan.planner).toBe('local')
    await first
    expect(session.getState()).toBe(local)
  })
})
