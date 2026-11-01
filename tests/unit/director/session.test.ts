import { describe, expect, it, vi } from 'vitest'
import { CloudError } from '../../../src/cloud/errors.ts'
import { SpendLedger } from '../../../src/cloud/spend.ts'
import { MemoryStorage } from '../../../src/cloud/keys.ts'
import {
  DirectorError,
  DirectorSession,
  directorMeta,
  planLocally,
  type DirectorRequest,
  type DirectorState,
  type Planner,
} from '../../../src/director/index.ts'
import { summaryLeft } from '../../../src/director/expand.ts'
import type { DirectorDeps } from '../../../src/director/session.ts'
import { BARS_NOTES } from '../../../src/model/queries.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { JobError, JobRunner } from '../../../src/shared/jobs.ts'
import { buildVisualAnalysis } from '../../../src/vision/analysisData.ts'
import {
  analysis,
  badKey,
  contentPolicy,
  DOWNBEATS,
  SECTIONS,
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
    // The note is its own field: the panel shows it above Generate, not among the plan's notes.
    expect(planned.stopped).toBeUndefined()
    expect(after.stopped).toBe('Generation stopped. 2\u00a0shots made so far are kept.')
    expect(after.preview.warnings).not.toContain(after.stopped)
    const kept = after.generatedShots
    expect(kept).toBe(2)
    expect(after.cost?.count).toBe(total - kept)
    // The summary counts what is left to generate, as the Generate button does.
    expect(planned.preview.summary).toContain(`, ${total} to generate`)
    expect(after.preview.summary).toBe(
      planned.preview.summary.replace(`, ${total} to generate`, `, ${total - kept} to generate`),
    )
    expect(summaryLeft(planned.plan, 0)).toBe(planned.preview.summary.replace(`, ${total} to generate`, ''))

    provider.gate = undefined
    const callsBefore = provider.calls.length
    expect((await session.apply({ confirmSpend: true })).status).toBe('applied')
    expect(provider.calls.length - callsBefore).toBe(total - kept)
  })

  it('shows what the run has spent so far, against its estimate, and where each shot stands', async () => {
    // The first two requests finish; the next two stay underway until the user cancels.
    const provider = fakeProvider({
      gate: (i) => (i < 2 ? Promise.resolve() : new Promise<void>(() => undefined)),
    })
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 5 })
    const planned = ready(await session.plan({ kind: 'ai', generate: { mode: 'images', tier: 'draft' } }))
    const applying = session.apply()
    const generating = () => {
      const s = session.getState()
      return s.status === 'generating' ? s : undefined
    }
    for (let i = 0; i < 50 && (generating()?.done ?? 0) < 2; i++) await new Promise((r) => setTimeout(r, 0))
    const state = generating()!
    expect(state.usd).toBe(planned.cost!.usd)
    const billed = provider.calls.slice(0, 2).reduce((sum, call) => sum + provider.estimate(call).usd, 0)
    expect(billed).toBeGreaterThan(0)
    expect(state.spentUsd).toBeCloseTo(billed, 6)
    expect(state.shots.map((s) => s.state)).toEqual([
      'done',
      'done',
      'sending',
      'sending',
      ...Array<string>(planned.cost!.count - 4).fill('waiting'),
    ])
    session.cancel()
    await applying
  })

  it('keeps and records a clip fal.ai finished when Cancel lands during its download', async () => {
    const downloading: (() => void)[] = []
    const provider = fakeProvider({
      gate: (i, ctx) => {
        if (i > 0) return new Promise<void>(() => undefined)
        ctx.progress({ stage: 'download', fraction: 0.92, message: 'Downloading the video' })
        return new Promise<void>((resolve) => downloading.push(resolve))
      },
    })
    const { session, ledger, store } = setup({ provider, videos: 0, confirmAboveUsd: 100 })
    ready(await session.plan({ kind: 'ai', seed: 2, generate: { mode: 'video', tier: 'draft' } }))
    const applying = session.apply()
    for (let i = 0; i < 50 && provider.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 0))
    expect(downloading).toHaveLength(1)
    session.cancel()
    expect(session.getState()).toMatchObject({ status: 'generating', stopping: { keeping: 1 } })
    downloading[0]!()
    const after = ready(await applying)
    expect(after.stopped).toBe('Generation stopped. 1\u00a0clip made so far is kept.')
    expect(after.generatedShots).toBe(1)
    expect(store.stored).toHaveLength(1)
    expect(ledger.monthTotal()).toBeCloseTo(provider.estimate(provider.calls[0]!).usd, 6)
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

  it('gives each distinct reason the failed shots failed for once', async () => {
    const provider = fakeProvider({
      failOn: (i) => (i < 2 ? providerDown() : i === 2 ? contentPolicy() : undefined),
    })
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 100 })
    ready(await session.plan({ kind: 'ai', seed: 2, generate: { mode: 'images', tier: 'draft' } }))
    const applied = await session.apply()
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`)
    expect(applied.failedShots).toBe(3)
    expect(applied.failedReasons).toEqual(['fal.ai said: HTTP 500', 'fal.ai said: Prompt was blocked'])
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

  it('drafts with AI video clips: priced as clips, counted as each one finishes, placed as video clips on the bars', async () => {
    const provider = fakeProvider({ failOn: (i) => (i === 1 ? providerDown() : undefined) })
    const { session, editor } = setup({ provider, videos: 0, confirmAboveUsd: 100 })
    const planned = ready(
      await session.plan({ kind: 'ai', seed: 2, generate: { mode: 'video', tier: 'draft' } }),
    )
    const count = planned.cost!.count
    expect(planned.unit).toBe('clip')
    expect(planned.actionLabel.startsWith(`Generate ${count} clips · about $`)).toBe(true)
    const seen: { done: number; failed: number }[] = []
    session.subscribe(() => {
      const s = session.getState()
      if (s.status === 'generating') seen.push({ done: s.done, failed: s.failed })
    })

    const applied = await session.apply()
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`)
    expect(applied.unit).toBe('clip')
    expect(applied.failedShots).toBe(1)
    // One note for the failure, pointing at Retry; fal.ai's own words go under the Retry button.
    expect(applied.warnings).toContain(
      '1 clip couldn’t be generated. Retry it below; a dark placeholder marks its\u00a0place.',
    )
    expect(applied.warnings.filter((w) => w.includes('placeholder'))).toHaveLength(1)
    expect(applied.failedReasons).toEqual(['fal.ai said: HTTP 500'])
    const done = [...new Set(seen.map((s) => s.done))]
    expect(done).toEqual(Array.from({ length: count + 1 }, (_, i) => i))
    expect(seen.at(-1)).toEqual({ done: count, failed: 1 })

    const project = editor.getProject()
    const shots = Object.values(project.clips).filter((c) => directorMeta(c)?.role === 'shots')
    const videos = shots.filter((c) => c.type === 'video')
    expect(videos.length).toBeGreaterThan(count)
    const onBar = (t: number) =>
      [...DOWNBEATS, ...SECTIONS.map((x) => x.start)].some((b) => Math.abs(b - t) < 0.01)
    for (const clip of videos) {
      expect(onBar(clip.start), `${clip.name} at ${clip.start}`).toBe(true)
      if (clip.type !== 'video') continue
      expect(project.assets[clip.assetId]?.origin.type).toBe('generated')
      expect(clip.muted).toBe(true)
    }
    // The failed clip's shots wait as placeholders for a retry.
    expect(shots.some((c) => c.type === 'solid' && directorMeta(c)?.pending?.task === 'text-to-video')).toBe(
      true,
    )
  })

  it('gives a failure on this device its own words, without "fal.ai said"', async () => {
    const provider = fakeProvider()
    const generate = provider.generate.bind(provider)
    provider.generate = async (request, ctx) => {
      const index = provider.calls.length
      const result = await generate(request, ctx)
      return index === 1 ? { ...result, media: [] } : result
    }
    const { session } = setup({ provider, videos: 0, confirmAboveUsd: 100 })
    ready(await session.plan({ kind: 'ai', seed: 2, generate: { mode: 'images', tier: 'draft' } }))
    const applied = await session.apply()
    if (applied.status !== 'applied') throw new Error(`expected applied, got ${applied.status}`)
    expect(applied.failedShots).toBe(1)
    expect(applied.failedReasons).toEqual(['The provider returned no media for this shot.'])
  })

  it('records nothing for a clip fal.ai failed itself, so its retry is the only charge for it', async () => {
    const failedByFal = new CloudError({
      kind: 'server',
      provider: 'fal',
      title: 'fal.ai had a problem',
      message: 'Internal server error',
      status: 500,
      uncharged: true,
    })
    // Every request reaches COMPLETED; the second one's result is fal.ai's own server error.
    const provider = fakeProvider({
      gate: (_, ctx) => {
        ctx.progress({ stage: 'download', fraction: 0.9 })
        return Promise.resolve()
      },
      failOn: (i) => (i === 1 ? failedByFal : undefined),
    })
    const { session, ledger } = setup({ provider, videos: 0, confirmAboveUsd: 100 })
    const planned = ready(
      await session.plan({ kind: 'ai', seed: 2, generate: { mode: 'video', tier: 'draft' } }),
    )
    const first = await session.apply()
    if (first.status !== 'applied') throw new Error(`expected applied, got ${first.status}`)
    expect(first.failedShots).toBe(1)
    const retried = await session.apply()
    if (retried.status !== 'applied') throw new Error(`expected applied, got ${retried.status}`)
    expect(retried.failedShots).toBe(0)
    expect(ledger.monthTotal()).toBeCloseTo(planned.cost!.usd, 4)
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

  /** The stages and times left the plan job reports, in order. */
  function etasOf(jobs: JobRunner): [string | undefined, number | undefined][] {
    const seen: [string | undefined, number | undefined][] = []
    jobs.subscribe((list) => {
      const p = list.find((s) => s.kind === 'director.plan')?.progress
      const last = seen[seen.length - 1]
      if (p && (last?.[0] !== p.stage || last?.[1] !== p.etaSeconds)) seen.push([p.stage, p.etaSeconds])
    })
    return seen
  }
  const findsBars =
    (editor: ProjectEditor): DirectorDeps['ensureBars'] =>
    ({ progress }) => {
      // The beat model downloads first, with no time known; then the time Beat This! still needs.
      progress(0.2)
      progress(0.6, 20)
      editor.dispatch(
        { type: 'analysis.setAudio', analysis: analysis({ downbeats: DOWNBEATS }) },
        { history: 'skip' },
      )
      return Promise.resolve(true)
    }

  it('says how long finding the bars and the built-in planner take, and nothing more once it plans', async () => {
    const editor = withoutBars()
    const jobs = new JobRunner()
    const seen = etasOf(jobs)
    await planWith(editor, findsBars(editor), jobs)
    expect(seen).toContainEqual(['bars', undefined])
    // Beat This!'s 20 s, then 2 s to plan.
    expect(seen).toContainEqual(['bars', 22])
    const after = seen.slice(seen.findIndex(([stage]) => stage === 'gather'))
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(([, eta]) => eta === undefined)).toBe(true)
  })

  it('gives no time left when a language model writes the plan, since its time is unknown', async () => {
    const editor = withoutBars()
    const jobs = new JobRunner()
    const seen = etasOf(jobs)
    ready(
      await new DirectorSession({
        editor,
        jobs,
        ensureBars: findsBars(editor),
        planner: (input) => planLocally(input),
      }).plan(REQUEST),
    )
    expect(seen.map(([stage]) => stage)).toContain('bars')
    expect(seen.every(([, eta]) => eta === undefined)).toBe(true)

    // With no model connected, that planner plans on this device, so the time left shows again.
    const offline = withoutBars()
    const offlineJobs = new JobRunner()
    const offlineSeen = etasOf(offlineJobs)
    ready(
      await new DirectorSession({
        editor: offline,
        jobs: offlineJobs,
        ensureBars: findsBars(offline),
        planner: (input) => planLocally(input),
        plansWithModel: () => false,
      }).plan(REQUEST),
    )
    expect(offlineSeen).toContainEqual(['bars', 22])
  })

  it('says the cuts follow the beats when the bars could not be found', async () => {
    const planned = ready(await planWith(withoutBars(), () => Promise.resolve(false)))
    expect(planned.preview.warnings).toContain(BARS_NOTES.beatsOnly)
  })

  it('gives a second pass of finding the bars its own band above the first, so the bar keeps moving', async () => {
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
    const bars = seen.filter(([stage]) => stage === 'bars').map(([, f]) => f ?? 0)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toBeCloseTo(0.5)
    expect(bars[1]).toBeCloseTo(0.56)
    expect(bars[2]).toBeCloseTo(0.62)
    // Planning takes the rest of the bar after both passes.
    expect(seen.find(([stage]) => stage === 'gather')?.[1]).toBeCloseTo(0.715)
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

  it('is not slow while a second pass of the bars moves', async () => {
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

describe('DirectorSession and clips that show nothing', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** What the app's fast blank check stores for a clip whose frames it found black. */
  const checkedBlack = (editor: ProjectEditor, assetId: string) =>
    editor.dispatch(
      {
        type: 'analysis.setVisual',
        analysis: buildVisualAnalysis({
          assetId,
          duration: 6,
          sourceSize: { width: 1920, height: 1080 },
          blankCheck: { peakLuma: 0, frames: 8 },
        }),
      },
      { history: 'skip' },
    )
  const LEFT_OUT = 'Left out “video3.mp4” because every frame of it is black or see-through.'

  it('checks the clips while it waits for the song, and waits for the check to leave out one that shows nothing', async () => {
    const project = makeProject()
    delete project.analysis.audio[SONG_ID]
    const editor = new ProjectEditor(project)
    const jobs = new JobRunner()
    const seen = stagesOf(jobs)
    let songReady!: () => void
    let checked!: () => void
    let checking = false
    const session = new DirectorSession({
      editor,
      jobs,
      waitForSong: () =>
        new Promise<void>((resolve) => {
          songReady = () => {
            editor.dispatch(
              { type: 'analysis.setAudio', analysis: analysis({ downbeats: DOWNBEATS }) },
              { history: 'skip' },
            )
            resolve()
          }
        }),
      checkClips: ({ progress }) => {
        checking = true
        progress(0.5)
        return new Promise<void>((resolve) => {
          checked = () => {
            checkedBlack(editor, 'video3')
            resolve()
          }
        })
      },
    })
    const planned = session.plan(REQUEST)
    await tick()
    expect(checking).toBe(true)
    expect(seen.some(([stage]) => stage === 'clips')).toBe(false)
    songReady()
    await tick()
    await tick()
    expect(seen[seen.length - 1]).toEqual(['clips', 0.025])
    expect(session.getState()).toMatchObject({
      status: 'planning',
      stage: 'clips',
      message: 'Checking your clips…',
    })
    checked()
    const state = await planned
    expect(ready(state).plan.warnings).toContain(LEFT_OUT)
  })

  it('says nothing about a check done in time, plans on when the check fails, and checks nothing without media', async () => {
    const plan = (check: (editor: ProjectEditor) => Promise<void>, request: DirectorRequest = REQUEST) => {
      const editor = new ProjectEditor(makeProject())
      const jobs = new JobRunner()
      const seen = stagesOf(jobs)
      const planned = new DirectorSession({ editor, jobs, checkClips: () => check(editor) }).plan(request)
      return { planned, seen }
    }
    const inTime = plan(async (editor) => checkedBlack(editor, 'video3'))
    expect(ready(await inTime.planned).plan.warnings).toContain(LEFT_OUT)
    expect(inTime.seen.some(([stage]) => stage === 'clips')).toBe(false)

    expect((await plan(() => Promise.reject(new Error('no decoder'))).planned).status).toBe('ready')

    const unused = vi.fn(async () => undefined)
    await plan(unused, { ...REQUEST, useMedia: false }).planned
    expect(unused).not.toHaveBeenCalled()
  })
})
