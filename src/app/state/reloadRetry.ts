import type { LyricsRequest } from '../../analysis/lyrics/client.ts'
import type { Id } from '../../model/index.ts'
import { jobs, type JobSnapshot } from '../../shared/jobs.ts'
import { stateToHash } from './hash.ts'
import { heldDraftOf, useDirector } from './director.ts'
import { JOB_KINDS, runningJobs, useJobs } from './jobs.ts'
import { heldDraft, reloadDraftNote } from './leaveDraft.ts'
import { startLyrics } from './lyrics.ts'
import { keepNow, saveBeforeReload, usePersistence } from './persistence.ts'
import { editor } from './project.ts'
import { startStems } from './stems.ts'
import { get, set, useUi } from './ui.ts'

/*
 * "Reload and try again" after stem separation or lyric timing ran out of memory. Earlier work in a long session can
 * keep memory in use until the page reloads, so a plain retry can fail again where one after a reload works. The
 * project is kept first, and the task starts again once it has reopened.
 */

export type RetryTask = { kind: 'stems' } | { kind: 'lyrics'; request: LyricsRequest }

interface PendingRetry {
  projectId: Id
  task: RetryTask
  at: number
}

const KEY = 'mv-studio.retry-after-reload'
/** Older than this, the page was not reloaded for the retry but reopened later (session restore keeps the entry). */
const FRESH_MS = 2 * 60_000
/** Background analysis that starts again by itself once the project reopens, so a reload loses none of it. */
const RESTARTS: ReadonlySet<string> = new Set([JOB_KINDS.downbeats, JOB_KINDS.footage, JOB_KINDS.suitability])

/** Running jobs that a reload would stop for good, such as an export. */
export function reloadBlockers(list: readonly JobSnapshot[] = jobs.list()): JobSnapshot[] {
  return runningJobs([...list]).filter((j) => !RESTARTS.has(j.kind))
}

/**
 * Whether the reload has to wait: for a job it would stop, or for the Director's draft holding AI shots
 * (leaveDraft.ts), which it would drop. Waiting says so in the footer, where the browser would only ask "Leave site?".
 */
export function reloadHeldBack(list: readonly JobSnapshot[] = jobs.list()): boolean {
  return reloadBlockers(list).length > 0 || heldDraft() !== null
}

/** Why the Director's draft holds the reload back, or null (a string, so the store selector stays stable). */
export const useReloadDraftNote = (): string | null =>
  useDirector((s) => {
    const held = heldDraftOf(s.state)
    return held ? reloadDraftNote(held) : null
  })

/** reloadHeldBack() for components, which show and focus Reload and try again only when it can run. */
export function useReloadHeldBack(): boolean {
  const job = reloadBlockers(useJobs()).length > 0
  const draft = useReloadDraftNote() !== null
  return job || draft
}

function isTask(task: unknown): task is RetryTask {
  if (typeof task !== 'object' || task === null || !('kind' in task)) return false
  if (task.kind === 'stems') return true
  if (task.kind !== 'lyrics' || !('request' in task)) return false
  const request = task.request as { kind?: unknown; text?: unknown } | null
  return request?.kind === 'draft' || (request?.kind === 'time' && typeof request.text === 'string')
}

/** The retry asked for before this page loaded, if it is still fresh. It is removed as it is read, so it runs once. */
export function takePendingRetry(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now(),
): PendingRetry | null {
  let raw: string | null
  try {
    raw = storage.getItem(KEY)
    if (raw !== null) storage.removeItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let pending: Partial<PendingRetry>
  try {
    pending = JSON.parse(raw) as Partial<PendingRetry>
  } catch {
    return null
  }
  const age = now - Number(pending.at)
  if (typeof pending.projectId !== 'string' || !(age >= 0 && age < FRESH_MS) || !isTask(pending.task))
    return null
  return { projectId: pending.projectId, task: pending.task, at: Number(pending.at) }
}

/**
 * Keeps the open project with every change written, then reloads the page into the same project and Assist view,
 * where `task` starts again. Does nothing while the reload is held back (reloadHeldBack), or when the project can't
 * be saved (its toast says why).
 */
export async function reloadAndRetry(task: RetryTask): Promise<void> {
  if (reloadHeldBack()) return
  const projectId = editor.getProject().id
  if (!(await keepNow()) || !(await saveBeforeReload())) return
  if (editor.getProject().id !== projectId || reloadHeldBack()) return
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ projectId, task, at: Date.now() } satisfies PendingRetry))
  } catch {
    // Storage blocked: the reload still frees the memory, and Try again is there afterwards.
  }
  set({ rightTab: 'assist', assistView: task.kind })
  // The link names the kept project, so the reload opens it rather than the start screen or the sample.
  window.history.replaceState(null, '', stateToHash(get(), editor.getProject()))
  window.location.reload()
}

let started = false

/** After a reload for a retry: once its project has reopened, shows its Assist view and starts the task again. */
export function initRetryAfterReload(): void {
  if (started) return
  started = true
  let storage: Storage
  try {
    // Reading the global itself throws where the browser blocks storage.
    storage = sessionStorage
  } catch {
    return
  }
  const pending = takePendingRetry(storage)
  if (!pending) return
  const { projectId, task } = pending
  let done = false
  const stop = () => {
    done = true
    stopPersistence()
    stopEditor()
    stopUi()
    clearTimeout(timer)
  }
  const check = () => {
    if (done) return
    // Leaving the editor before the project has reopened (Home, Back) gives up the retry.
    if (get().screen !== 'editor') return stop()
    if (usePersistence.getState().restoring) return
    stop()
    if (editor.getProject().id !== projectId) return
    set({ rightTab: 'assist', assistView: task.kind })
    if (task.kind === 'stems') void startStems()
    else void startLyrics(task.request)
  }
  const stopPersistence = usePersistence.subscribe(check)
  const stopEditor = editor.subscribe(check)
  const stopUi = useUi.subscribe(check)
  const timer = setTimeout(stop, FRESH_MS)
  check()
}
