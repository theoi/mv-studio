import { describe, expect, it } from 'vitest'
import { JobError, JobRunner, type JobSnapshot } from '../../../src/shared/jobs.ts'

describe('JobRunner', () => {
  it('reports progress and finishes with fraction 1', async () => {
    const runner = new JobRunner()
    const seen: JobSnapshot[] = []
    const job = runner.run({
      kind: 'test',
      title: 'Counting',
      async run(ctx) {
        ctx.progress({ fraction: 0.25, stage: 'a' })
        ctx.progress({ fraction: 0.75, message: 'almost' })
        return 42
      },
    })
    job.subscribe((s) => seen.push(s))
    await expect(job.promise).resolves.toBe(42)
    expect(seen.map((s) => s.status)).toEqual(['running', 'running', 'running', 'succeeded'])
    expect(job.snapshot().progress).toMatchObject({ fraction: 1, stage: 'a', message: 'almost' })
    expect(runner.list().map((s) => s.status)).toEqual(['succeeded'])
  })

  it('cancels a running job and rejects with a cancelled JobError', async () => {
    const runner = new JobRunner()
    const job = runner.run({
      kind: 'test',
      title: 'Waiting',
      run: (ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    })
    await Promise.resolve()
    await Promise.resolve()
    job.cancel()
    const error = await job.promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).code).toBe('cancelled')
    expect(job.snapshot().status).toBe('cancelled')
  })

  it('says a job that took a Cancel is stopping until it ends', async () => {
    const runner = new JobRunner()
    let finish!: () => void
    const job = runner.run({
      kind: 'test',
      title: 'Downloading the clip',
      // Like a job keeping a result it already paid for: it doesn't stop the moment Cancel is pressed.
      run: () => new Promise<void>((resolve) => (finish = resolve)),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(job.snapshot().stopping).toBeFalsy()
    job.cancel()
    expect(job.snapshot()).toMatchObject({ status: 'running', stopping: true })
    expect(runner.list()).toMatchObject([{ status: 'running', stopping: true }])
    finish()
    expect(((await job.promise.catch((e: unknown) => e)) as JobError).code).toBe('cancelled')
    expect(job.snapshot().status).toBe('cancelled')
    expect(job.snapshot().stopping).toBeFalsy()
    expect(runner.list()[0]?.stopping).toBeFalsy()
  })

  it('does not say a job that already ended is stopping when Cancel comes too late', async () => {
    const runner = new JobRunner()
    const job = runner.run({ kind: 'test', title: 'Quick', run: async () => 1 })
    await job.promise
    job.cancel()
    expect(job.snapshot().status).toBe('succeeded')
    expect(job.snapshot().stopping).toBeFalsy()
  })

  it('maps storage quota failures to a typed error', async () => {
    const runner = new JobRunner()
    const job = runner.run({
      kind: 'test',
      title: 'Saving',
      async run() {
        throw new DOMException('full', 'QuotaExceededError')
      },
    })
    const error = (await job.promise.catch((e: unknown) => e)) as JobError
    expect(error.code).toBe('storage-quota')
    expect(job.snapshot()).toMatchObject({
      status: 'failed',
      error: { code: 'storage-quota', retryable: false },
    })
  })

  it('keeps network errors retryable and round-trips through JSON', () => {
    const e = new JobError('network', 'offline')
    expect(e.retryable).toBe(true)
    const back = JobError.fromJSON(JSON.parse(JSON.stringify(e)))
    expect(back).toMatchObject({ code: 'network', message: 'offline', retryable: true })
  })

  it('recognizes exhausted memory in the words of WebAssembly runtimes', () => {
    expect(JobError.from(new Error('std::bad_alloc')).code).toBe('out-of-memory')
    expect(JobError.from(new Error('Aborted(OOM)')).code).toBe('out-of-memory')
    expect(JobError.from(new Error('Out of memory: Cannot allocate Wasm memory')).code).toBe('out-of-memory')
    expect(JobError.from(new Error('Unexpected token < in JSON')).code).toBe('internal')
  })

  it('makes worker crashes retryable', () => {
    expect(new JobError('worker-crashed', 'The worker stopped').retryable).toBe(true)
  })
})
