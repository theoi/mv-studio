import { afterEach, describe, expect, it } from 'vitest'
import { JobError } from '../../../src/shared/jobs.ts'
import { createWorkerClient, exposeWorker, transfer, type Endpoint } from '../../../src/shared/worker.ts'
import { closeFakeWorkers, FakeWorker } from './fakeWorker.ts'

const api = {
  async double(args: { values: number[] }, ctx: { progress(p: { fraction: number }): void }) {
    ctx.progress({ fraction: 0.5 })
    return args.values.map((v) => v * 2)
  },
  async fail() {
    throw new JobError('decode', 'bad file')
  },
  waitForCancel(_args: undefined, ctx: { signal: AbortSignal }) {
    return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('saw abort')))
  },
  stopSlowly(_args: undefined, ctx: { signal: AbortSignal }) {
    return new Promise((resolve) =>
      ctx.signal.addEventListener('abort', () =>
        setTimeout(() => {
          stopped = true
          resolve('stopped')
        }, 30),
      ),
    )
  },
  async makeBuffer(args: { size: number }) {
    const buf = new ArrayBuffer(args.size)
    return transfer(buf, [buf])
  },
}

let stopped = false
let channel: MessageChannel | undefined

function connect() {
  channel = new MessageChannel()
  exposeWorker(api, channel.port1 as unknown as Endpoint)
  return createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)
}

afterEach(() => {
  channel?.port1.close()
  channel?.port2.close()
})

describe('worker RPC', () => {
  it('returns results and forwards progress', async () => {
    const client = connect()
    const progress: number[] = []
    const result = await client.call(
      'double',
      { values: [1, 2, 3] },
      { onProgress: (p) => progress.push(p.fraction ?? -1) },
    )
    expect(result).toEqual([2, 4, 6])
    expect(progress).toEqual([0.5])
  })

  it('rethrows typed errors from the worker', async () => {
    const client = connect()
    const error = await client.call('fail', undefined).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).code).toBe('decode')
  })

  it('propagates cancellation to the worker handler', async () => {
    const client = connect()
    const controller = new AbortController()
    const pending = client.call('waitForCancel', undefined, { signal: controller.signal })
    controller.abort()
    const error = (await pending.catch((e: unknown) => e)) as JobError
    expect(error.code).toBe('cancelled')
  })

  it('with awaitCancel, settles only after the worker handler has stopped', async () => {
    const client = connect()
    stopped = false
    const controller = new AbortController()
    const pending = client.call('stopSlowly', undefined, { signal: controller.signal, awaitCancel: true })
    controller.abort()
    const error = (await pending.catch((e: unknown) => e)) as JobError
    expect(error.code).toBe('cancelled')
    expect(stopped).toBe(true)
  })

  it('transfers buffers returned with transfer()', async () => {
    const client = connect()
    const buf = await client.call('makeBuffer', { size: 1024 })
    expect(buf).toBeInstanceOf(ArrayBuffer)
    expect((buf as ArrayBuffer).byteLength).toBe(1024)
  })
})

describe('workers that die', () => {
  afterEach(() => closeFakeWorkers())

  it('fail pending calls with a retryable worker-crashed error on an uncaught error, and are stopped', async () => {
    const worker = new FakeWorker(api)
    const client = createWorkerClient<typeof api>(worker.asWorker())
    expect(await client.call('double', { values: [1] })).toEqual([2])
    const pending = client.call('waitForCancel', undefined).catch((e: unknown) => e)
    expect(worker.crash('Uncaught TypeError: session.run is not a function')).toBe(true)
    const error = (await pending) as JobError
    expect(error).toBeInstanceOf(JobError)
    expect(error).toMatchObject({ code: 'worker-crashed', retryable: true })
    expect(error.details).toBe('TypeError: session.run is not a function')
    expect(worker.terminated).toBe(true)
    // Given the worker itself, the client cannot replace it: later calls fail at once.
    await expect(client.call('double', { values: [1] })).rejects.toBe(error)
    expect(client.failure()).toBe(error)
  })

  it('fail with out-of-memory when the uncaught error says memory ran out', async () => {
    const worker = new FakeWorker(api)
    const client = createWorkerClient<typeof api>(worker.asWorker())
    const pending = client.call('waitForCancel', undefined).catch((e: unknown) => e)
    worker.crash('Uncaught RangeError: Array buffer allocation failed')
    expect(await pending).toMatchObject({ code: 'out-of-memory', retryable: true })
  })

  it('are replaced on the next call when the client makes its workers', async () => {
    const made: FakeWorker[] = []
    const client = createWorkerClient<typeof api>(() => {
      const worker = new FakeWorker(api)
      made.push(worker)
      return worker.asWorker()
    })
    expect(made).toHaveLength(0)
    const pending = client.call('waitForCancel', undefined).catch((e: unknown) => e)
    made[0]?.crash('Uncaught Error: boom')
    expect(await pending).toMatchObject({ code: 'worker-crashed' })
    expect(client.failure()?.code).toBe('worker-crashed')
    expect(await client.call('double', { values: [2] })).toEqual([4])
    expect(made).toHaveLength(2)
    expect(made[0]?.terminated).toBe(true)
    expect(client.failure()).toBeNull()
    client.terminate()
    expect(made[1]?.terminated).toBe(true)
  })

  it('fail pending calls when a reply from the worker cannot be read', async () => {
    const worker = new FakeWorker(api)
    const client = createWorkerClient<typeof api>(worker.asWorker())
    const pending = client.call('waitForCancel', undefined).catch((e: unknown) => e)
    worker.dispatchEvent(new Event('messageerror'))
    expect(await pending).toMatchObject({ code: 'internal' })
    expect(worker.terminated).toBe(true)
  })

  it('fail pending calls when the worker cannot read a request', async () => {
    const worker = new FakeWorker(api)
    const client = createWorkerClient<typeof api>(worker.asWorker())
    const pending = client.call('waitForCancel', undefined).catch((e: unknown) => e)
    worker.channel.port1.dispatchEvent(new MessageEvent('messageerror'))
    expect(await pending).toMatchObject({ code: 'internal' })
  })
})

describe('worker client', () => {
  it('rejects arguments that cannot be sent with a JobError', async () => {
    const client = connect()
    await expect(client.call('double', { values: [() => 1] } as never)).rejects.toBeInstanceOf(JobError)
  })

  it('rejects calls made after terminate() instead of leaving them pending', async () => {
    const client = connect()
    client.terminate()
    await expect(client.call('double', { values: [1] })).rejects.toMatchObject({ code: 'cancelled' })
  })
})
