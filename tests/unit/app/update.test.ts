import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UpdateModule from '../../../src/app/state/update.ts'
import type * as JobsModule from '../../../src/shared/jobs.ts'
import type * as UiModule from '../../../src/app/state/ui.ts'

let update: typeof UpdateModule
let shared: typeof JobsModule
let ui: typeof UiModule
let deployed: { build: string; time: number }
let fetchMock: ReturnType<typeof vi.fn>
let reload: ReturnType<typeof vi.fn>
let stop: (() => void) | undefined

const later = { build: 'a build deployed later', time: __BUILD_TIME__ + 60_000 }

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['performance'] })
  deployed = { build: __BUILD_ID__, time: __BUILD_TIME__ }
  fetchMock = vi.fn(async () => new Response(JSON.stringify(deployed)))
  reload = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      location: { reload, hash: '' },
    }),
  )
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      visibilityState: 'visible',
      documentElement: { toggleAttribute() {} },
    }),
  )
  shared = await import('../../../src/shared/jobs.ts')
  ui = await import('../../../src/app/state/ui.ts')
  update = await import('../../../src/app/state/update.ts')
  stop = update.initUpdateCheck()
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function runJob(error?: Error): Promise<void> {
  const handle = shared.jobs.run({
    kind: 'test.task',
    title: 'A task',
    run: async () => {
      if (error) throw error
    },
  })
  await handle.promise.catch(() => undefined)
  await flush()
}

const updateToast = () => ui.get().toasts.find((t) => t.message === update.UPDATED_MESSAGE)

describe('a tab open over a deploy', () => {
  it("checks the deployed build at once when a task's worker dies, and offers a reload", async () => {
    await runJob()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateToast()).toBeUndefined()

    deployed = later
    await runJob(new shared.JobError('worker-crashed', 'The task stopped unexpectedly. Try again.'))
    // The task that started checked a moment ago; the failure checks again anyway.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(updateToast()).toMatchObject({ action: { label: 'Save and reload' }, sticky: true })
  })

  it('also when code of the build failed to load in a task', async () => {
    await runJob()
    deployed = later
    await runJob(new Error('Failed to fetch dynamically imported module: /mv-studio/assets/encode-abc.js'))
    expect(updateToast()).toBeDefined()
  })

  it('waits for its time after a task that failed for another reason', async () => {
    await runJob()
    deployed = later
    await runJob(new shared.JobError('decode', 'The audio couldn’t be decoded'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateToast()).toBeUndefined()
  })

  it('checks when the tab comes back to the front, at most every five minutes', async () => {
    deployed = later
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(updateToast()).toBeDefined()
    ui.dismissToast(updateToast()!.id)

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5 * 60_000)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(updateToast()).toBeDefined()
  })

  it('offers nothing while the deployed build is this one', async () => {
    window.dispatchEvent(new Event('focus'))
    await flush()
    await runJob(new shared.JobError('worker-crashed', 'The task stopped unexpectedly. Try again.'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(updateToast()).toBeUndefined()
  })

  it('reloads from the toast', async () => {
    deployed = later
    window.dispatchEvent(new Event('focus'))
    await flush()
    updateToast()!.action!.run()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('stays when the project could not be saved, and offers the reload again', async () => {
    stop?.()
    vi.resetModules()
    vi.doMock('../../../src/app/state/persistence.ts', () => ({ saveBeforeReload: async () => false }))
    ui = await import('../../../src/app/state/ui.ts')
    update = await import('../../../src/app/state/update.ts')
    stop = update.initUpdateCheck()
    deployed = later
    window.dispatchEvent(new Event('focus'))
    await flush()
    const offered = updateToast()!
    // As the toast's button does: run the action, then close the toast.
    offered.action!.run()
    ui.dismissToast(offered.id)
    await flush()
    expect(reload).not.toHaveBeenCalled()
    expect(updateToast()).toMatchObject({ action: { label: 'Save and reload' }, sticky: true })
    vi.doUnmock('../../../src/app/state/persistence.ts')
  })
})
