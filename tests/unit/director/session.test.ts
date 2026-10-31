import { describe, expect, it } from 'vitest'
import { SpendLedger } from '../../../src/cloud/spend.ts'
import { MemoryStorage } from '../../../src/cloud/keys.ts'
import {
  DirectorError,
  DirectorSession,
  directorMeta,
  type DirectorState,
} from '../../../src/director/index.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { JobRunner } from '../../../src/shared/jobs.ts'
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
  session.subscribe(() => states.push(session.getState().status))
  return { project, editor, session, ledger, store, states }
}

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
