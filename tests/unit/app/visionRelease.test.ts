import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  releaseVisionWorkers,
  setVisionBackendsForTests,
  visionService,
} from '../../../src/app/state/footage.ts'
import { JOB_KINDS } from '../../../src/app/state/jobs.ts'
import { leaveProjectJobs } from '../../../src/app/state/persistence.ts'
import { JobError, jobs, type JobContext } from '../../../src/shared/jobs.ts'

const release = vi.fn((_options?: { idleMs?: number }) => true)

beforeAll(async () => {
  setVisionBackendsForTests({
    segmentation: () => ({}) as never,
    onnx: () => ({}) as never,
    release,
  })
  await visionService()
})

afterEach(() => {
  jobs.cancelAll()
  vi.useRealTimers()
})

/** A job of `kind` that runs until `finish()` or a cancel. */
function job(kind: string) {
  let finish = () => {}
  const handle = jobs.run({
    kind,
    title: kind,
    run: (ctx: JobContext) =>
      new Promise<void>((resolve, reject) => {
        finish = resolve
        ctx.signal.addEventListener('abort', () => reject(new JobError('cancelled', 'Cancelled')))
      }),
  })
  return { handle, finish: () => finish() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Releases that were not the idle timer's. */
const now = () => release.mock.calls.filter(([o]) => !o?.idleMs).length

it('frees the vision workers when stem separation or lyric timing starts, once no vision job is running', async () => {
  release.mockClear()
  const index = job(JOB_KINDS.footage)
  await settle()
  const stems = job(JOB_KINDS.stems)
  await settle()
  expect(now()).toBe(0)
  index.finish()
  await settle()
  expect(now()).toBe(1)
  // The same separation is not a reason to free them again.
  const cut = job(JOB_KINDS.autocut)
  await settle()
  cut.finish()
  await settle()
  expect(now()).toBe(1)
  stems.finish()
  await settle()
  for (const kind of [JOB_KINDS.lyrics, JOB_KINDS.realign]) {
    const timing = job(kind)
    await settle()
    timing.finish()
    await settle()
  }
  expect(now()).toBe(3)
})

it('frees nothing while a vision job is queued, even one queued in the same task', async () => {
  release.mockClear()
  const check = job(JOB_KINDS.suitability)
  expect(check.handle.snapshot().status).toBe('queued')
  releaseVisionWorkers()
  expect(now()).toBe(0)
  await settle()
  expect(now()).toBe(0)
  check.finish()
  await settle()
  expect(now()).toBe(1)
})

it('frees them on opening another project once its cancelled vision jobs have stopped', async () => {
  release.mockClear()
  const cutout = job(JOB_KINDS.cutout)
  await settle()
  expect(cutout.handle.snapshot().status).toBe('running')
  leaveProjectJobs()
  expect(now()).toBe(0)
  await settle()
  expect(cutout.handle.snapshot().status).toBe('cancelled')
  expect(now()).toBe(1)
})

it('tries again while a call outside any job keeps a worker', async () => {
  release.mockClear()
  release.mockReturnValueOnce(false)
  releaseVisionWorkers()
  expect(now()).toBe(1)
  const other = job('test.other')
  await settle()
  expect(now()).toBe(2)
  other.finish()
  await settle()
  expect(now()).toBe(2)
})

it('frees workers idle for a minute once no vision job has run for a minute', async () => {
  vi.useFakeTimers()
  const camera = job(JOB_KINDS.camera)
  await vi.advanceTimersByTimeAsync(0)
  release.mockClear()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(release).not.toHaveBeenCalled()
  camera.finish()
  await vi.advanceTimersByTimeAsync(59_000)
  expect(release).not.toHaveBeenCalled()
  // A vision job in that minute starts it over.
  const index = job(JOB_KINDS.footage)
  await vi.advanceTimersByTimeAsync(2_000)
  index.finish()
  await vi.advanceTimersByTimeAsync(59_000)
  expect(release).not.toHaveBeenCalled()
  // A worker a search used meanwhile is kept, and looked at again a minute later.
  release.mockReturnValueOnce(false)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(release.mock.calls).toEqual([[{ idleMs: 60_000 }]])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(release.mock.calls).toEqual([[{ idleMs: 60_000 }], [{ idleMs: 60_000 }]])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(release).toHaveBeenCalledTimes(2)
})
