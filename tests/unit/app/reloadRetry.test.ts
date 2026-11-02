import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDirector } from '../../../src/app/state/director.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { reloadBlockers, reloadHeldBack, takePendingRetry } from '../../../src/app/state/reloadRetry.ts'
import type { DirectorState } from '../../../src/director/index.ts'
import type * as Stems from '../../../src/app/state/stems.ts'
import type { JobSnapshot, JobStatus } from '../../../src/shared/jobs.ts'

vi.mock('../../../src/app/state/stems.ts', async (original) => ({
  ...(await original<typeof Stems>()),
  startStems: vi.fn(),
}))

const KEY = 'mv-studio.retry-after-reload'
const NOW = Date.UTC(2026, 10, 2, 12)

function storage(value?: unknown) {
  const kept = new Map<string, string>()
  if (value !== undefined) kept.set(KEY, typeof value === 'string' ? value : JSON.stringify(value))
  return {
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    removeItem: (key: string) => void kept.delete(key),
  }
}

describe('the retry asked for before a reload', () => {
  it('is read once, then removed', () => {
    const s = storage({ projectId: 'p1', task: { kind: 'stems' }, at: NOW - 5000 })
    expect(takePendingRetry(s, NOW)).toEqual({ projectId: 'p1', task: { kind: 'stems' }, at: NOW - 5000 })
    expect(s.kept.has(KEY)).toBe(false)
    expect(takePendingRetry(s, NOW)).toBeNull()
  })

  it('keeps the pasted lyrics of a lyric timing', () => {
    const task = { kind: 'lyrics', request: { kind: 'time', text: 'First line\nSecond line' } }
    expect(takePendingRetry(storage({ projectId: 'p1', task, at: NOW - 1000 }), NOW)?.task).toEqual(task)
  })

  it('is dropped when stale: the tab was reopened later rather than reloaded', () => {
    expect(
      takePendingRetry(storage({ projectId: 'p1', task: { kind: 'stems' }, at: NOW - 120_000 }), NOW),
    ).toBeNull()
    expect(
      takePendingRetry(storage({ projectId: 'p1', task: { kind: 'stems' }, at: NOW + 1000 }), NOW),
    ).toBeNull()
  })

  it('is dropped when it is not a retry it can start', () => {
    expect(takePendingRetry(storage('{not json'), NOW)).toBeNull()
    expect(takePendingRetry(storage({ task: { kind: 'stems' }, at: NOW }), NOW)).toBeNull()
    expect(takePendingRetry(storage({ projectId: 'p1', task: { kind: 'export' }, at: NOW }), NOW)).toBeNull()
    const noText = { kind: 'lyrics', request: { kind: 'time' } }
    expect(takePendingRetry(storage({ projectId: 'p1', task: noText, at: NOW }), NOW)).toBeNull()
  })
})

describe('jobs a reload would stop', () => {
  const job = (kind: string, status: JobStatus = 'running'): JobSnapshot => ({
    id: `${kind}-${status}`,
    kind,
    title: kind,
    status,
    progress: { fraction: 0.5 },
  })

  it('include an export, an import and an auto-cut, queued or running', () => {
    const list = [job(JOB_KINDS.export), job(JOB_KINDS.import, 'queued'), job(JOB_KINDS.autocut)]
    expect(reloadBlockers(list).map((j) => j.kind)).toEqual([
      JOB_KINDS.export,
      JOB_KINDS.import,
      JOB_KINDS.autocut,
    ])
  })

  it('leave out background analysis that starts again after the reload, and finished jobs', () => {
    const list = [
      job(JOB_KINDS.footage),
      job(JOB_KINDS.downbeats),
      job(JOB_KINDS.suitability),
      job(JOB_KINDS.stems, 'failed'),
      job(JOB_KINDS.export, 'succeeded'),
    ]
    expect(reloadBlockers(list)).toEqual([])
  })
})

describe('the Director’s draft holding the reload back', () => {
  afterEach(() => useDirector.setState({ state: { status: 'idle' } }))

  it('waits while the draft holds AI shots a reload would drop, with no job running', () => {
    expect(reloadHeldBack([])).toBe(false)
    const failed = { status: 'applied', plan: {}, failedShots: 1, unit: 'shot' } as unknown as DirectorState
    useDirector.setState({ state: failed })
    expect(reloadHeldBack([])).toBe(true)
    useDirector.setState({ state: { ...failed, failedShots: 0 } as DirectorState })
    expect(reloadHeldBack([])).toBe(false)
  })
})

describe('starting the retry once the project has reopened', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function reloaded() {
    const stems = await import('../../../src/app/state/stems.ts')
    const { usePersistence } = await import('../../../src/app/state/persistence.ts')
    const ui = await import('../../../src/app/state/ui.ts')
    const { editor } = await import('../../../src/app/state/project.ts')
    const { initRetryAfterReload } = await import('../../../src/app/state/reloadRetry.ts')
    vi.stubGlobal(
      'sessionStorage',
      storage({ projectId: editor.getProject().id, task: { kind: 'stems' }, at: Date.now() }),
    )
    ui.set({ screen: 'editor', rightTab: 'inspector', assistView: 'home' })
    usePersistence.setState({ restoring: true })
    initRetryAfterReload()
    return { startStems: vi.mocked(stems.startStems), usePersistence, ui }
  }

  it('starts the task in its Assist view after the restore', async () => {
    const { startStems, usePersistence, ui } = await reloaded()
    expect(startStems).not.toHaveBeenCalled()
    usePersistence.setState({ restoring: false })
    expect(startStems).toHaveBeenCalledTimes(1)
    expect(ui.get()).toMatchObject({ screen: 'editor', rightTab: 'assist', assistView: 'stems' })
  })

  it('gives it up when the user leaves the editor before the restore ends', async () => {
    const { startStems, usePersistence, ui } = await reloaded()
    ui.set({ screen: 'start' })
    usePersistence.setState({ restoring: false })
    ui.set({ screen: 'editor' })
    expect(startStems).not.toHaveBeenCalled()
    expect(ui.get().screen).toBe('editor')
  })
})
