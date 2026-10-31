import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Workers that die mid-call: their calls fail with a typed error instead of hanging, and the next call or job gets a
 * fresh worker. Killing a worker from outside (Worker.terminate()) fires no event, like the browser stopping a worker
 * that ran out of memory.
 */

/** Records the workers the page starts with this name, so the test can kill them. */
async function recordWorkers(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    const RealWorker = window.Worker
    const started: Worker[] = []
    window.mvStudio.startedWorkers = started
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name === name) started.push(this)
      }
    }
  }, name)
}

test('a worker killed mid-call fails the call with worker-crashed, and the next call starts a fresh worker', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { client, workers } = window.mvStudio.testing.crashTestClient()
    const settle = (p: Promise<unknown>) =>
      p.then(
        (value) => ({ value }),
        (e: { code: string; retryable: boolean; message: string }) => ({
          code: e.code,
          retryable: e.retryable,
          message: e.message,
        }),
      )
    const within = (p: Promise<unknown>, ms: number) =>
      Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('still pending'), ms))])
    const first = await client.call('echo', { value: 1 })

    let running = () => {}
    const started = new Promise<void>((resolve) => (running = resolve))
    const hung = settle(client.call('hang', undefined, { onProgress: () => running() }))
    await started
    const killedAt = performance.now()
    workers[0].terminate()
    const killed = await within(hung, 5000)
    const ms = performance.now() - killedAt
    const failure = client.failure()?.code
    const again = await client.call('echo', { value: 2 })

    // An allocation failure outside any call: every pending call fails, and the worker is replaced too.
    const pending = settle(client.call('hang', undefined))
    await client.call('exhaustMemoryLater', undefined)
    const outOfMemory = await within(pending, 5000)
    const third = await client.call('echo', { value: 3 })
    client.terminate()
    return { first, killed, ms, failure, again, outOfMemory, third, workers: workers.length }
  })
  console.log('worker crash', JSON.stringify(r))
  expect(r.first).toBe(1)
  expect(r.killed).toMatchObject({ code: 'worker-crashed', retryable: true })
  expect(r.ms).toBeLessThan(1000)
  expect(r.failure).toBe('worker-crashed')
  expect(r.again).toBe(2)
  expect(r.outOfMemory).toMatchObject({ code: 'out-of-memory', retryable: true })
  expect(r.third).toBe(3)
  expect(r.workers).toBe(3)
})

test('an export whose render worker dies fails with worker-crashed, leaves no file, and the next export works', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await recordWorkers(page, 'render')
  const r = await page.evaluate(async () => {
    const { model, engine, shared } = window.mvStudio
    const started: Worker[] = window.mvStudio.startedWorkers
    const project = (duration: number) => {
      const p = model.createProject({ name: 'Crash me' })
      const solid = model.createSolidClip({ trackId: p.tracks[0].id, color: '#336699', start: 0, duration })
      p.clips[solid.id] = solid
      return p
    }
    const exportJob = (duration: number) =>
      shared.jobs.run({
        kind: 'export.mp4',
        title: 'Export video',
        run: (ctx: unknown) =>
          engine.exporter.exportProject(
            project(duration),
            { width: 640, height: 360, fps: 30, aspect: '16:9' },
            ctx,
          ),
      })
    const job = exportJob(30)
    await new Promise<void>((resolve) => {
      const off = job.subscribe((s: { progress: { stage?: string } }) => {
        if (s.progress.stage === 'render') {
          off()
          resolve()
        }
      })
    })
    const killedAt = performance.now()
    started[0]?.terminate()
    const error = await Promise.race([
      job.promise.then(
        () => 'finished',
        (e: { code: string; retryable: boolean }) => ({ code: e.code, retryable: e.retryable }),
      ),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000)),
    ])
    const ms = performance.now() - killedAt
    const root = await navigator.storage.getDirectory()
    const exports = await root.getDirectoryHandle('exports', { create: true })
    const entries: string[] = []
    for await (const name of (exports as unknown as { keys(): AsyncIterable<string> }).keys())
      entries.push(name)
    const retry = await exportJob(1).promise
    return {
      error,
      ms,
      status: job.snapshot().status,
      entries,
      retrySeconds: retry.durationSeconds,
      workers: started.length,
    }
  })
  console.log('export worker crash', JSON.stringify(r))
  expect(r.error).toEqual({ code: 'worker-crashed', retryable: true })
  expect(r.ms).toBeLessThan(2000)
  expect(r.status).toBe('failed')
  expect(r.entries).toEqual([])
  expect(r.retrySeconds).toBeCloseTo(1, 1)
  expect(r.workers).toBe(2)
})

test('a preview whose render worker dies reports the error once instead of retrying every frame', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openHarness(page)
  await recordWorkers(page, 'preview')
  const r = await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    const started: Worker[] = window.mvStudio.startedWorkers
    const solid = (color: string) => {
      const p = model.createProject({ name: color })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
      p.clips[clip.id] = clip
      return p
    }
    const preview = new engine.PreviewController({
      canvas: document.createElement('canvas'),
      media: media.mediaStore,
      renderer: 'worker',
    })
    preview.setViewport(64, 36, 1)
    preview.setProject(solid('#ff0000'))
    await preview.rendered()
    const worker = preview.stats().worker
    started[0]?.terminate()
    // Edits and seeks after the worker died: each would have tried (and failed) to draw.
    const outcomes: string[] = []
    for (const [i, color] of ['#00ff00', '#0000ff', '#ffff00'].entries()) {
      preview.setProject(solid(color))
      preview.seek(i * 0.5)
      outcomes.push(
        await Promise.race([
          preview.rendered().then(
            () => 'rendered',
            (e: { code: string }) => e.code,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 5000)),
        ]),
      )
    }
    const error = preview.getSnapshot().error
    preview.dispose()
    return { worker, outcomes, error: error && { code: error.code, retryable: error.retryable } }
  })
  console.log('preview worker crash', JSON.stringify(r), errors)
  expect(r.worker).toBe(true)
  expect(r.outcomes).toEqual(['worker-crashed', 'worker-crashed', 'worker-crashed'])
  expect(r.error).toEqual({ code: 'worker-crashed', retryable: true })
  expect(errors.filter((e) => e.includes('Preview render failed'))).toEqual([])
  expect(errors.filter((e) => e.includes('The preview stopped drawing'))).toHaveLength(1)
})

test('a preview whose render worker dies while it starts draws on the main thread or reports the error, instead of waiting forever', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openHarness(page)
  await recordWorkers(page, 'preview')
  const r = await page.evaluate(async () => {
    const { model, media, engine, testing } = window.mvStudio
    const started: Worker[] = window.mvStudio.startedWorkers
    const solid = (color: string) => {
      const p = model.createProject({ name: color })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
      p.clips[clip.id] = clip
      return p
    }
    const settle = (preview: { rendered(): Promise<void> }) =>
      Promise.race([
        preview.rendered().then(
          () => 'rendered',
          (e: { code: string }) => e.code,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 20_000)),
      ])
    const results = []
    for (const delay of [0, 20, 100]) {
      const preview = new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer: 'worker',
      })
      const worker = started[started.length - 1]
      preview.setViewport(64, 36, 1)
      preview.setProject(solid('#ff0000'))
      const startedAt = performance.now()
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      worker?.terminate()
      // The worker may have drawn this frame before it was killed; the edit after the kill must be drawn or refused.
      await settle(preview)
      preview.setProject(solid('#00ff00'))
      const outcome = await settle(preview)
      const ms = Math.round(performance.now() - startedAt)
      let center: number[] | null = null
      if (outcome === 'rendered') {
        const frame: ImageBitmap = await preview.captureFrame()
        const d = testing.readPixels(frame, 8, 8)
        const i = (4 * 8 + 4) * 4
        center = [d[i], d[i + 1], d[i + 2]]
        frame.close()
      }
      results.push({
        delay,
        outcome,
        ms,
        worker: preview.stats().worker,
        error: preview.getSnapshot().error?.code ?? null,
        center,
      })
      preview.dispose()
    }
    return results
  })
  console.log('preview worker killed while starting', JSON.stringify(r))
  expect(r).toHaveLength(3)
  // Stopped before it ran a line, the worker never answers: after the start timeout, the main thread draws.
  expect(r[0]).toMatchObject({ outcome: 'rendered', worker: false, error: null, center: [0, 255, 0] })
  expect(r[0]?.ms).toBeGreaterThan(14_000)
  for (const x of r) {
    // Killed before the canvas moved, the main thread draws; after, the preview reports why it cannot.
    if (x.worker) expect(x).toMatchObject({ outcome: 'worker-crashed', error: 'worker-crashed' })
    else expect(x).toMatchObject({ outcome: 'rendered', error: null, center: [0, 255, 0] })
    expect(x.ms).toBeLessThan(17_000)
  }
  // The worker holds its watch lock within milliseconds of starting, so a kill 100 ms in is noticed at once.
  expect(r[2]?.ms).toBeLessThan(5000)
  expect(errors.filter((e) => e.includes('Preview render failed'))).toEqual([])
})
test('a preview whose render worker dies or hangs once it has the canvas reports why, before its first frame', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    type Plan = { method: 'previewStart' | 'previewRender'; action: 'kill' | 'hang' }
    let plan: Plan | null = null
    const workers: { terminated: boolean }[] = []
    // Kills the preview worker right after the client sends it `plan.method`, or drops that message and every later
    // one, like a worker stuck in a GPU driver call.
    window.Worker = class extends window.Worker {
      private readonly record: { terminated: boolean } | null = null
      private hung = false
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name === 'preview') {
          this.record = { terminated: false }
          workers.push(this.record)
        }
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
        const call = message as { kind?: string; method?: string }
        const hit = this.record && plan && call?.kind === 'call' && call.method === plan.method
        if (this.hung || (hit && plan?.action === 'hang')) {
          this.hung = true
          return
        }
        super.postMessage(message, transfer as Transferable[])
        if (hit) super.terminate()
      }
      terminate(): void {
        if (this.record) this.record.terminated = true
        super.terminate()
      }
    }
    const solid = (color: string) => {
      const p = model.createProject({ name: color })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
      p.clips[clip.id] = clip
      return p
    }
    const settle = (preview: { rendered(): Promise<void> }, ms: number) =>
      Promise.race([
        preview.rendered().then(
          () => 'rendered',
          (e: { code: string }) => e.code,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), ms)),
      ])
    const plans: Plan[] = [
      { method: 'previewStart', action: 'kill' },
      { method: 'previewRender', action: 'kill' },
      { method: 'previewStart', action: 'hang' },
      { method: 'previewRender', action: 'hang' },
    ]
    const results = []
    for (const next of plans) {
      plan = next
      const preview = new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer: 'worker',
      })
      preview.setViewport(64, 36, 1)
      preview.setProject(solid('#ff0000'))
      const startedAt = performance.now()
      const outcome = await settle(preview, 25_000)
      const ms = Math.round(performance.now() - startedAt)
      // Later edits fail at once instead of waiting for the worker again.
      preview.setProject(solid('#0000ff'))
      const again = await settle(preview, 1000)
      results.push({
        ...next,
        outcome,
        ms,
        again,
        error: preview.getSnapshot().error?.code ?? null,
        worker: preview.stats().worker,
        terminated: workers.at(-1)?.terminated ?? null,
      })
      preview.dispose()
    }
    return results
  })
  console.log('preview worker failing after the canvas moved', JSON.stringify(r))
  expect(r).toHaveLength(4)
  for (const x of r) {
    const code = x.action === 'kill' ? 'worker-crashed' : 'timeout'
    expect(x).toMatchObject({ outcome: code, again: code, error: code, worker: true, terminated: true })
    if (x.action === 'kill') expect(x.ms).toBeLessThan(3000)
    else {
      expect(x.ms).toBeGreaterThan(14_000)
      expect(x.ms).toBeLessThan(18_000)
    }
  }
  expect(errors.filter((e) => e.includes('Preview render failed'))).toEqual([])
  expect(errors.filter((e) => e.includes('The preview stopped drawing'))).toHaveLength(4)
})
