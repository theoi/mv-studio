import { JobError } from '../../shared/jobs.ts'
import type { JobProgress as Progress } from '../../shared/jobs.ts'
import type { TaskOptions } from './tasks.ts'

interface Subscriber {
  onProgress?: (p: Progress) => void
  reject: (err: unknown) => void
}

interface Running {
  promise: Promise<unknown>
  controller: AbortController
  subscribers: Set<Subscriber>
  last: Progress | null
}

export type SharedRunner = <T>(
  key: string,
  start: (options: TaskOptions & { signal: AbortSignal }) => Promise<T>,
  options?: TaskOptions,
) => Promise<T>

/**
 * Deduplicates identical long-running tasks (same analysis requested from several places).
 * Every caller gets progress and can cancel independently; the underlying task is only
 * cancelled once all of its callers have cancelled.
 */
export function createSharedRunner(): SharedRunner {
  const running = new Map<string, Running>()
  return <T>(
    key: string,
    start: (options: TaskOptions & { signal: AbortSignal }) => Promise<T>,
    options: TaskOptions = {},
  ): Promise<T> => {
    if (options.signal?.aborted) return Promise.reject(new JobError('cancelled', 'The task was cancelled.'))
    let task = running.get(key)
    if (!task) {
      const controller = new AbortController()
      const subscribers = new Set<Subscriber>()
      const created: Running = { promise: Promise.resolve(), controller, subscribers, last: null }
      created.promise = start({
        signal: controller.signal,
        onProgress: (p) => {
          created.last = p
          for (const s of subscribers) s.onProgress?.(p)
        },
      }).finally(() => {
        if (running.get(key) === created) running.delete(key)
      })
      running.set(key, created)
      task = created
    }
    const current = task
    return new Promise<T>((resolve, reject) => {
      const sub: Subscriber = { ...(options.onProgress ? { onProgress: options.onProgress } : {}), reject }
      current.subscribers.add(sub)
      if (current.last) sub.onProgress?.(current.last)
      const onAbort = () => {
        current.subscribers.delete(sub)
        if (current.subscribers.size === 0) {
          current.controller.abort()
          if (running.get(key) === current) running.delete(key)
        }
        reject(new JobError('cancelled', 'The task was cancelled.'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      ;(current.promise as Promise<T>).then(
        (value) => {
          options.signal?.removeEventListener('abort', onAbort)
          if (current.subscribers.delete(sub)) resolve(value)
        },
        (err: unknown) => {
          options.signal?.removeEventListener('abort', onAbort)
          if (current.subscribers.delete(sub)) reject(err)
        },
      )
    })
  }
}
