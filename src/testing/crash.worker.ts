/** A worker for tests of workers that die mid-call (tests/e2e/worker-crash.spec.ts). */
import { exposeWorker, type WorkerCallContext } from '../shared/worker.ts'

const api = {
  echo: (args: { value: number }) => args.value,
  /** Reports progress once running, then stays pending until the worker dies. */
  hang: (_args: undefined, ctx: WorkerCallContext) =>
    new Promise<never>(() => ctx.progress({ stage: 'running' })),
  /** Runs out of WebAssembly memory outside any call, as a model runtime's failed allocation does. */
  exhaustMemoryLater: () => {
    setTimeout(() => new WebAssembly.Memory({ initial: 1, maximum: 1 }).grow(1))
  },
}

export type CrashTestApi = typeof api

exposeWorker(api)
