import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobError } from '../../../../src/shared/jobs.ts'
import { createWorkerBackends, type WorkerBackends } from '../../../../src/vision/workers/backends.ts'
import { closeFakeWorkers, FakeWorker } from '../../shared/fakeWorker.ts'

const fakeOnnx = {
  async embedTexts(input: { texts: string[] }) {
    return input.texts.map((t) => [t.length])
  },
  depth() {
    return new Promise(() => undefined)
  },
}

let made: { name: string | undefined; worker: FakeWorker }[] = []
let backends: WorkerBackends | undefined

beforeEach(() => {
  made = []
  vi.stubGlobal(
    'Worker',
    class {
      constructor(_url: URL, options?: WorkerOptions) {
        const worker = new FakeWorker(fakeOnnx)
        made.push({ name: options?.name, worker })
        return worker.asWorker()
      }
    },
  )
})

afterEach(() => {
  backends?.dispose()
  closeFakeWorkers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const embed = (b: WorkerBackends, texts: string[]) =>
  b.onnx().embedTexts({ texts, model: 'clip' } as never) as Promise<unknown>
const hang = (b: WorkerBackends) => (b.onnx().depth({} as never) as Promise<unknown>).catch((e: unknown) => e)

describe('vision worker backends', () => {
  it('start the worker on the first call, not before', async () => {
    backends = createWorkerBackends()
    backends.onnx()
    expect(made).toHaveLength(0)
    expect(await embed(backends, ['abc'])).toEqual([[3]])
    expect(made.map((m) => m.name)).toEqual(['vision-onnx'])
  })

  it('fail pending calls when the worker crashes and run the next call in a fresh worker', async () => {
    backends = createWorkerBackends()
    const pending = hang(backends)
    await vi.waitFor(() => expect(made).toHaveLength(1))
    made[0]?.worker.crash('Uncaught Error: session lost')
    const error = await pending
    expect(error).toBeInstanceOf(JobError)
    expect(error).toMatchObject({ code: 'worker-crashed', retryable: true })
    expect(await embed(backends, ['hello'])).toEqual([[5]])
    expect(made).toHaveLength(2)
    expect(made[0]?.worker.terminated).toBe(true)
  })

  it('replace a worker whose reply could not be read instead of failing every later call', async () => {
    backends = createWorkerBackends()
    const pending = hang(backends)
    await vi.waitFor(() => expect(made).toHaveLength(1))
    made[0]?.worker.dispatchEvent(new Event('messageerror'))
    expect(await pending).toMatchObject({ code: 'internal' })
    expect(await embed(backends, ['ok'])).toEqual([[2]])
    expect(made).toHaveLength(2)
  })

  it('stop their workers on dispose, and start new ones when used again', async () => {
    backends = createWorkerBackends()
    await embed(backends, ['a'])
    backends.dispose()
    expect(made[0]?.worker.terminated).toBe(true)
    expect(await embed(backends, ['ab'])).toEqual([[2]])
    expect(made).toHaveLength(2)
  })

  it('release idle workers but stay usable through the clients already handed out', async () => {
    backends = createWorkerBackends()
    // The vision service keeps the clients it got when it was made.
    const onnx = backends.onnx()
    const segmentation = backends.segmentation('background')
    expect(await onnx.embedTexts({ texts: ['abc'], model: 'clip' } as never)).toEqual([[3]])
    await segmentation.resetStream(null).catch(() => undefined)
    expect(made.map((m) => m.name)).toEqual(['vision-onnx', 'vision-segmentation-background'])
    // Used a moment ago: kept when only workers idle for a minute may go.
    expect(backends.release({ idleMs: 60_000 })).toBe(false)
    expect(made.some((m) => m.worker.terminated)).toBe(false)
    const stop = new AbortController()
    const pending = (onnx.depth({} as never, { signal: stop.signal }) as Promise<unknown>).catch(
      (e: unknown) => e,
    )
    expect(backends.release()).toBe(false)
    expect(made[0]?.worker.terminated).toBe(false)
    expect(made[1]?.worker.terminated).toBe(true)
    stop.abort()
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(backends.release()).toBe(true)
    expect(made[0]?.worker.terminated).toBe(true)
    expect(await onnx.embedTexts({ texts: ['hello'], model: 'clip' } as never)).toEqual([[5]])
    expect(made.map((m) => m.name)).toEqual(['vision-onnx', 'vision-segmentation-background', 'vision-onnx'])
  })

  it('count a worker as idle from when its last call ended, not began', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    backends = createWorkerBackends()
    const call = embed(backends, ['abc'])
    clock = 120_000
    expect(await call).toEqual([[3]])
    clock = 150_000
    expect(backends.release({ idleMs: 60_000 })).toBe(false)
    expect(made[0]?.worker.terminated).toBe(false)
    clock = 180_000
    expect(backends.release({ idleMs: 60_000 })).toBe(true)
    expect(made[0]?.worker.terminated).toBe(true)
  })
})
