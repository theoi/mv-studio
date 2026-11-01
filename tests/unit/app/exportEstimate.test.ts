import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  drawnKey,
  outputEstimate,
  QUIET_WAIT_MS,
  runTrials,
  SETTLE_MS,
  unsettledTrials,
  type TrialEnvironment,
} from '../../../src/app/state/exportEstimate.ts'
import { newOutput, planOutput, type PlannedOutput } from '../../../src/export/index.ts'
import { createProject, createSolidClip, ProjectEditor, type Project } from '../../../src/model/index.ts'

describe('what an export time trial is kept for', () => {
  it('stays the same through an analysis write, which stamps the project too, and changes when the drawing does', () => {
    const p = createProject()
    p.songAssetId = 'song'
    p.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      tempo: { bpm: 120, confidence: 1 },
      beats: [0, 0.5],
    }
    let ms = Date.parse(p.updatedAt)
    const editor = new ProjectEditor(p, { now: () => new Date((ms += 1000)) })
    const before = drawnKey(editor.getProject())
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: 'song',
        grid: { tempo: { bpm: 128, confidence: 1 }, beats: [0, 0.47] },
      },
      { history: 'skip' },
    )
    expect(editor.getProject().updatedAt).not.toBe(p.updatedAt)
    expect(drawnKey(editor.getProject())).toBe(before)
    editor.dispatch({ type: 'project.updateSettings', settings: { backgroundColor: '#ff0000' } })
    expect(drawnKey(editor.getProject())).not.toBe(before)
  })
})

/** A new 60 s project (so trials of earlier tests don't count) and its 720p video output. */
function output(): { project: Project; planned: PlannedOutput } {
  const project = createProject({ name: 'Trial' })
  const solid = createSolidClip({ trackId: project.tracks[0]!.id, color: '#333333', start: 0, duration: 60 })
  project.clips[solid.id] = solid
  project.duration = 60
  return { project, planned: planOutput(project, newOutput(project, 'video', { resolution: '720p' })) }
}

/** Jobs that start and end when the test says, and trials that finish when it resolves them. */
function environment(options: { busy?: boolean; pageAge?: number } = {}) {
  let busy = options.busy ?? false
  const loaded = Date.now() - (options.pageAge ?? 60_000)
  const listeners = new Set<() => void>()
  const trials: ((seconds: number) => void)[] = []
  const env: TrialEnvironment = {
    pageAge: () => Date.now() - loaded,
    busy: () => busy,
    watchJobs: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    estimate: () =>
      new Promise((resolve) => trials.push((seconds) => resolve({ seconds, expected: { seconds } }))),
  }
  const setBusy = (value: boolean) => {
    busy = value
    for (const listener of [...listeners]) listener()
  }
  return { env, trials, setBusy }
}

const unsettled = (project: Project) => unsettledTrials().filter((k) => k.startsWith(`${drawnKey(project)}|`))
const shown = (project: Project, planned: PlannedOutput) => outputEstimate(project, planned)?.seconds

describe('when an export time trial runs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits while another job runs, and starts when it ends', async () => {
    const { project, planned } = output()
    const fake = environment({ busy: true })
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.trials).toHaveLength(0)
    fake.setBusy(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.trials).toHaveLength(1)
    fake.trials[0]!(600)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(project, planned)).toBe(600)
    expect(unsettled(project)).toEqual([])
  })

  it('waits until the page has been open a while', async () => {
    const { project, planned } = output()
    const fake = environment({ pageAge: 2000 })
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 2000 - 100)
    expect(fake.trials).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.trials).toHaveLength(1)
  })

  it('runs anyway once it has waited long enough, shows that figure, and replaces it with a trial once the job ends', async () => {
    const { project, planned } = output()
    const fake = environment({ busy: true })
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(QUIET_WAIT_MS)
    expect(fake.trials).toHaveLength(1)
    fake.trials[0]!(1200)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(project, planned)).toBe(1200)
    expect(unsettled(project)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.trials).toHaveLength(1)
    fake.setBusy(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.trials).toHaveLength(2)
    fake.trials[1]!(600)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(project, planned)).toBe(600)
    expect(unsettled(project)).toEqual([])
  })

  it('times the output again when a job ran during its trial, even one that ended before the trial did', async () => {
    const { project, planned } = output()
    const fake = environment()
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.trials).toHaveLength(1)
    fake.setBusy(true)
    fake.setBusy(false)
    fake.trials[0]!(900)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.trials).toHaveLength(2)
    fake.trials[1]!(600)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(project, planned)).toBe(600)
  })

  it('does not keep a trial taken under load when the dialog opens again, but times the output again', async () => {
    const { project, planned } = output()
    const fake = environment({ busy: true })
    const dialog = new AbortController()
    void runTrials(project, [planned], dialog.signal, fake.env)
    await vi.advanceTimersByTimeAsync(QUIET_WAIT_MS)
    fake.trials[0]!(1200)
    await vi.advanceTimersByTimeAsync(0)
    // Closed while the job still runs; it ends after.
    dialog.abort()
    fake.setBusy(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.trials).toHaveLength(1)
    // Opened again: the figure from under load shows while the output is timed again.
    expect(shown(project, planned)).toBe(1200)
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.trials).toHaveLength(2)
    fake.trials[1]!(600)
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(project, planned)).toBe(600)
  })

  it('keeps a trial that ran while nothing else did: opening the dialog again times nothing', async () => {
    const { project, planned } = output()
    const fake = environment()
    void runTrials(project, [planned], new AbortController().signal, fake.env)
    await vi.advanceTimersByTimeAsync(0)
    fake.trials[0]!(600)
    await vi.advanceTimersByTimeAsync(0)
    await runTrials(project, [planned], new AbortController().signal, fake.env)
    expect(fake.trials).toHaveLength(1)
    expect(shown(project, planned)).toBe(600)
  })
})
