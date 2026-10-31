import { describe, expect, it } from 'vitest'
import { createSharedRunner } from '../../../../src/vision/runtime/shared.ts'
import { prefetch } from '../../../../src/vision/runtime/frames.ts'
import type { JobProgress } from '../../../../src/shared/jobs.ts'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('shared runner', () => {
  it('runs identical tasks once and gives every caller the result and progress', async () => {
    const run = createSharedRunner()
    const gate = deferred<string>()
    let starts = 0
    let report: ((p: JobProgress) => void) | undefined
    const start = (o: { onProgress?: (p: JobProgress) => void }) => {
      starts++
      report = o.onProgress
      return gate.promise
    }
    const seenA: number[] = []
    const seenB: number[] = []
    const a = run('k', start, { onProgress: (p) => seenA.push(p.fraction ?? -1) })
    report?.({ fraction: 0.3 })
    const b = run('k', start, { onProgress: (p) => seenB.push(p.fraction ?? -1) })
    report?.({ fraction: 0.6 })
    gate.resolve('done')
    expect(await Promise.all([a, b])).toEqual(['done', 'done'])
    expect(starts).toBe(1)
    expect(seenA).toEqual([0.3, 0.6])
    expect(seenB).toEqual([0.3, 0.6])
  })

  it('keeps the task running while any caller remains and aborts it when all cancel', async () => {
    const run = createSharedRunner()
    let signal: AbortSignal | undefined
    const gate = deferred<number>()
    const start = (o: { signal: AbortSignal }) => {
      signal = o.signal
      return gate.promise
    }
    const c1 = new AbortController()
    const c2 = new AbortController()
    const a = run('k', start, { signal: c1.signal })
    const b = run('k', start, { signal: c2.signal })
    c1.abort()
    await expect(a).rejects.toMatchObject({ code: 'cancelled' })
    expect(signal?.aborted).toBe(false)
    c2.abort()
    await expect(b).rejects.toMatchObject({ code: 'cancelled' })
    expect(signal?.aborted).toBe(true)
  })

  it('starts a new task after the previous one finished', async () => {
    const run = createSharedRunner()
    let starts = 0
    const start = async () => ++starts
    expect(await run('k', start)).toBe(1)
    expect(await run('k', start)).toBe(2)
  })

  it('passes failures to every caller', async () => {
    const run = createSharedRunner()
    const start = async () => {
      throw new Error('boom')
    }
    const results = await Promise.allSettled([run('k', start), run('k', start)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  })
})

describe('prefetch', () => {
  async function* counter(n: number, produced: number[]) {
    for (let i = 0; i < n; i++) {
      produced.push(i)
      yield i
    }
  }

  it('reads ahead of the consumer', async () => {
    const produced: number[] = []
    const seen: Array<{ item: number; producedSoFar: number }> = []
    for await (const item of prefetch(counter(5, produced), 2))
      seen.push({ item, producedSoFar: produced.length })
    expect(seen.map((s) => s.item)).toEqual([0, 1, 2, 3, 4])
    expect(seen[0]!.producedSoFar).toBeGreaterThanOrEqual(2)
  })

  it('disposes items fetched ahead when the consumer stops early', async () => {
    const produced: number[] = []
    const disposed: number[] = []
    for await (const item of prefetch(counter(10, produced), 3, (i) => disposed.push(i)))
      if (item === 1) break
    expect(disposed.length).toBeGreaterThan(0)
    expect(disposed.every((i) => i > 1)).toBe(true)
    expect(produced.length).toBeLessThan(10)
  })
})
