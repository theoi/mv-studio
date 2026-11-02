import { describe, expect, it } from 'vitest'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { reloadBlockers, takePendingRetry } from '../../../src/app/state/reloadRetry.ts'
import type { JobSnapshot, JobStatus } from '../../../src/shared/jobs.ts'

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
