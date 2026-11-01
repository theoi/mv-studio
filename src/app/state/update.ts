/**
 * Offers a reload when a newer build of the studio has been deployed (src/shared/update.ts). A tab left open over a
 * deploy can't load the workers and screens of its own build any more, so its tasks fail ("The task stopped
 * unexpectedly"). The deployed build is checked when code fails to load or a task's worker dies, when a task starts,
 * and when the tab comes back to the front.
 */
import { jobs } from '../../shared/jobs.ts'
import { isLoadFailure, newerBuildDeployed } from '../../shared/update.ts'
import { saveBeforeReload } from './persistence.ts'
import { get, toast } from './ui.ts'

export const UPDATED_MESSAGE = 'MV Studio was updated. Reload to continue; your project is saved.'
const UPDATE_KEY = 'update'
/** Checks when a task starts or the tab comes back are at most this often; after a failure, at once. */
const CHECK_EVERY_MS = 5 * 60_000

let lastCheck = Number.NEGATIVE_INFINITY
let checking = false

async function reload(): Promise<void> {
  try {
    await saveBeforeReload()
  } finally {
    window.location.reload()
  }
}

/** Looks for a newer deployed build, and offers to reload into it. */
export function checkForUpdate({ now = false }: { now?: boolean } = {}): void {
  if (checking || get().toasts.some((t) => t.key === UPDATE_KEY)) return
  if (!now && performance.now() - lastCheck < CHECK_EVERY_MS) return
  checking = true
  lastCheck = performance.now()
  void newerBuildDeployed()
    .then((newer) => {
      if (newer)
        toast(
          UPDATED_MESSAGE,
          { label: 'Reload', run: () => void reload() },
          { key: UPDATE_KEY, sticky: true },
        )
    })
    .finally(() => (checking = false))
}

/** Starts checking; returns stop. */
export function initUpdateCheck(): () => void {
  const seen = new Set(jobs.list().map((j) => j.id))
  const failed = new Set(seen)
  const unsubscribe = jobs.subscribe(() => {
    for (const job of jobs.list()) {
      if (!seen.has(job.id)) {
        seen.add(job.id)
        checkForUpdate()
      }
      const error = job.error
      if (job.status !== 'failed' || !error || failed.has(job.id)) continue
      failed.add(job.id)
      if (error.code === 'worker-crashed' || isLoadFailure(error.message)) checkForUpdate({ now: true })
    }
  })
  const onVisible = () => {
    if (document.visibilityState === 'visible') checkForUpdate()
  }
  const onLoadFailed = () => checkForUpdate({ now: true })
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('vite:preloadError', onLoadFailed)
  return () => {
    unsubscribe()
    window.removeEventListener('focus', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('vite:preloadError', onLoadFailed)
  }
}
