import { exposeWorker, type Endpoint, type WorkerApi } from '../../../src/shared/worker.ts'

const open = new Set<FakeWorker>()

/**
 * A Worker stand-in: `api` runs behind a MessageChannel on this thread, and events can be fired at it the way the
 * browser fires them at a Worker.
 */
export class FakeWorker extends EventTarget {
  terminated = false
  readonly channel = new MessageChannel()

  constructor(api: WorkerApi) {
    super()
    exposeWorker(api, this.channel.port1 as unknown as Endpoint)
    this.channel.port2.onmessage = (event) =>
      this.dispatchEvent(new MessageEvent('message', { data: event.data }))
    open.add(this)
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.channel.port2.postMessage(message, transfer)
  }

  terminate(): void {
    this.terminated = true
    this.close()
  }

  /** An uncaught error in the worker, as the browser reports it; true if a listener handled it. */
  crash(message: string): boolean {
    const event = Object.assign(new Event('error', { cancelable: true }), { message })
    this.dispatchEvent(event)
    return event.defaultPrevented
  }

  asWorker(): Worker {
    return this as unknown as Worker
  }

  close(): void {
    this.channel.port1.close()
    this.channel.port2.close()
    open.delete(this)
  }
}

export function closeFakeWorkers(): void {
  for (const worker of open) worker.close()
}
