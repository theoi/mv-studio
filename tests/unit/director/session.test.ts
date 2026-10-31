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
import type { DirectorDeps } from '../../../src/director/session.ts'
import { BARS_NOTES } from '../../../src/model/queries.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import {
  analysis,
  badKey,
  DOWNBEATS,
  fakeProvider,
  makeProject,
  memoryStore,
  SONG_ID,
  type FakeProvider,
} from './fixtures.ts'

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

describe('DirectorSession and the song’s bars', () => {
  function withoutBars() {
    const project = makeProject()
    delete project.analysis.audio[SONG_ID]!.downbeats
    return new ProjectEditor(project)
  }
  const planWith = (editor: ProjectEditor, ensureBars?: DirectorDeps['ensureBars'], jobs = new JobRunner()) =>
    new DirectorSession({ editor, jobs, ...(ensureBars ? { ensureBars } : {}) }).plan({
      kind: 'beat-cut',
      seed: 4,
    })
  /** The stages and fractions the plan job reports, in order. */
  function progressOf(jobs: JobRunner): [string | undefined, number | undefined][] {
    const seen: [string | undefined, number | undefined][] = []
    jobs.subscribe((list) => {
      const p = list.find((s) => s.kind === 'director.plan')?.progress
      const last = seen[seen.length - 1]
      if (p && (last?.[0] !== p.stage || last?.[1] !== p.fraction)) seen.push([p.stage, p.fraction])
    })
    return seen
  }

  const cuts = (state: DirectorState) => ready(state).plan.shots.map((s) => [s.start, s.end])

  it('waits for the bars before planning and cuts on them', async () => {
    const onBars = cuts(await planWith(new ProjectEditor(makeProject())))
    expect(cuts(await planWith(withoutBars()))).not.toEqual(onBars)

    const editor = withoutBars()
    const found = await planWith(editor, () => {
      editor.dispatch(
        { type: 'analysis.setAudio', analysis: analysis({ downbeats: DOWNBEATS }) },
        { history: 'skip' },
      )
      return Promise.resolve(true)
    })
    expect(cuts(found)).toEqual(onBars)
    expect(ready(found).preview.warnings).not.toContain(BARS_NOTES.beatsOnly)
  })

  it('gives finding the bars half of the progress bar, and only when it runs', async () => {
    const editor = withoutBars()
    const jobs = new JobRunner()
    const seen = progressOf(jobs)
    await planWith(
      editor,
      ({ progress }) => {
        progress(0.6)
        editor.dispatch(
          { type: 'analysis.setAudio', analysis: analysis({ downbeats: DOWNBEATS }) },
          { history: 'skip' },
        )
        return Promise.resolve(true)
      },
      jobs,
    )
    expect(seen).toContainEqual(['bars', 0.3])
    expect(seen).toContainEqual(['gather', 0.525])
    expect(seen).toContainEqual(['plan', 0.65])

    const quick = new JobRunner()
    const quickSeen = progressOf(quick)
    await planWith(new ProjectEditor(makeProject()), () => Promise.resolve(true), quick)
    expect(quickSeen.map(([stage]) => stage)).not.toContain('bars')
    expect(quickSeen).toContainEqual(['gather', 0.05])
  })

  it('says the cuts follow the beats when the bars could not be found', async () => {
    const planned = ready(await planWith(withoutBars(), () => Promise.resolve(false)))
    expect(planned.preview.warnings).toContain(BARS_NOTES.beatsOnly)
  })

  it('never moves the bar back when finding the bars starts a second pass', async () => {
    const editor = withoutBars()
    const jobs = new JobRunner()
    const seen = progressOf(jobs)
    await planWith(
      editor,
      ({ progress }) => {
        progress(1)
        progress(0.3)
        progress(0.6)
        return Promise.resolve(false)
      },
      jobs,
    )
    const fractions = seen.flatMap(([, f]) => (f === undefined ? [] : [f]))
    expect(fractions.length).toBeGreaterThan(3)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    expect(seen).toContainEqual(['bars', 0.5])
  })
})

const REQUEST = { kind: 'beat-cut', seed: 4 } as const
const cutsOf = (state: DirectorState) => ready(state).plan.shots.map((s) => [s.start, s.end])
/** The stages and fractions a runner's plan job reports, in order. */
function stagesOf(jobs: JobRunner): [string | undefined, number | undefined][] {
  const seen: [string | undefined, number | undefined][] = []
  jobs.subscribe((list) => {
    const p = list.find((s) => s.kind === 'director.plan')?.progress
    const last = seen[seen.length - 1]
    if (p && (last?.[0] !== p.stage || last?.[1] !== p.fraction)) seen.push([p.stage, p.fraction])
  })
  return seen
}

describe('DirectorSession while the song is still being analyzed', () => {
  it('waits for the song analysis before planning, and it gets a quarter of the progress bar', async () => {
    const analyzed = cutsOf(
      await new DirectorSession({ editor: new ProjectEditor(makeProject()), jobs: new JobRunner() }).plan(
        REQUEST,
      ),
    )
    const project = makeProject()
    delete project.analysis.audio[SONG_ID]
    const editor = new ProjectEditor(project)
    const jobs = new JobRunner()
    const seen = stagesOf(jobs)
    const state = await new DirectorSession({
      editor,
      jobs,
      waitForSong: ({ progress }) => {
        progress(0.5)
        editor.dispatch(
          { type: 'analysis.setAudio', analysis: analysis({ downbeats: DOWNBEATS }) },
          { history: 'skip' },
        )
        return Promise.resolve()
      },
    }).plan(REQUEST)
    expect(seen).toContainEqual(['song', 0.125])
    expect(cutsOf(state)).toEqual(analyzed)
  })
})

describe('DirectorSession says it is slow only for the stage at hand', () => {
  const editor = () => {
    const project = makeProject()
    delete project.analysis.audio[SONG_ID]!.downbeats
    return new ProjectEditor(project)
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const slow = (session: DirectorSession) => (session.getState() as { slow?: boolean }).slow

  it('is not slow while the bars’ progress keeps moving, however long it takes', async () => {
    let seenSlow = false
    const session = new DirectorSession({
      editor: editor(),
      jobs: new JobRunner(),
      slowAfterMs: 30,
      stallAfterMs: 150,
      ensureBars: async ({ progress }) => {
        for (let i = 1; i <= 12; i++) {
          progress(i / 12)
          await sleep(15)
          seenSlow ||= slow(session) === true
        }
        return true
      },
    })
    ready(await session.plan(REQUEST))
    expect(seenSlow).toBe(false)
  })

  it('turns slow when the bars’ progress stalls, and not slow again when it moves', async () => {
    let resume: () => void = () => {}
    const session = new DirectorSession({
      editor: editor(),
      jobs: new JobRunner(),
      slowAfterMs: 1000,
      stallAfterMs: 30,
      ensureBars: async ({ progress }) => {
        progress(0.1)
        await new Promise<void>((resolve) => (resume = resolve))
        progress(0.5)
        await sleep(10)
        expect(slow(session)).toBe(false)
        return true
      },
    })
    const planned = session.plan(REQUEST)
    await vi.waitFor(() => expect(slow(session)).toBe(true))
    resume()
    ready(await planned)
  })

  it('is not slow while a second pass of the bars moves, though the bar waits above it', async () => {
    let seenSlow = false
    const session = new DirectorSession({
      editor: editor(),
      jobs: new JobRunner(),
      slowAfterMs: 1000,
      stallAfterMs: 60,
      ensureBars: async ({ progress }) => {
        progress(0.9)
        for (let i = 1; i <= 10; i++) {
          progress(i / 20)
          await sleep(20)
          seenSlow ||= slow(session) === true
        }
        return true
      },
    })
    ready(await session.plan(REQUEST))
    expect(seenSlow).toBe(false)
  })

  it('offers the local draft only once the AI model is planning, not while the bars are found', async () => {
    let resume: () => void = () => {}
    const session = new DirectorSession({
      editor: editor(),
      jobs: new JobRunner(),
      slowAfterMs: 5,
      stallAfterMs: 5,
      ensureBars: async ({ progress }) => {
        progress(0.1)
        await new Promise<void>((resolve) => (resume = resolve))
        return true
      },
      planner: (_input, ctx) => {
        ctx.progress({ stage: 'llm', message: 'Asking your AI model for ideas' })
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled'))),
        )
      },
    })
    const planned = session.plan(REQUEST)
    await vi.waitFor(() =>
      expect(session.getState()).toMatchObject({ stage: 'bars', slow: true, canUseLocal: false }),
    )
    resume()
    await vi.waitFor(() =>
      expect(session.getState()).toMatchObject({ stage: 'plan', slow: true, canUseLocal: true }),
    )
    session.cancel()
    await planned
  })

  it('gives planning its own clock after the bars', async () => {
    const session = new DirectorSession({
      editor: editor(),
      jobs: new JobRunner(),
      slowAfterMs: 150,
      stallAfterMs: 1000,
      ensureBars: async ({ progress }) => {
        for (let i = 1; i <= 6; i++) {
          progress(i / 6)
          await sleep(40)
        }
        return true
      },
      planner: (_input, ctx) => {
        ctx.progress({ stage: 'llm', message: 'Asking your AI model for ideas' })
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled'))),
        )
      },
    })
    const planned = session.plan(REQUEST)
    await vi.waitFor(() =>
      expect(session.getState()).toMatchObject({ message: 'Asking your AI model for ideas' }),
    )
    // The draft has run longer than slowAfterMs, but the planning stage has only just started.
    expect(slow(session)).toBe(false)
    await vi.waitFor(() => expect(slow(session)).toBe(true))
    session.cancel()
    await planned
  })
})
