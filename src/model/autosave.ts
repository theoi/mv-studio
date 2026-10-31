/**
 * Autosave: debounced saves of the editor's project, serialized so writes never overlap, with a status the UI can
 * show ("Saving…", "Saved", "Couldn't save").
 */
import type { ProjectEditor } from './editor.ts'
import type { Project } from './types.ts'

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface AutosaveState {
  status: AutosaveStatus
  lastSavedAt?: string
  error?: string
}

export interface AutosaveController {
  getState(): AutosaveState
  subscribe(listener: (state: AutosaveState) => void): () => void
  /**
   * Saves any pending change now and resolves when it is written. `leaving` (the page is closing) writes the latest
   * project at once, even while an earlier save is still running, and tells `save` so it can skip slow extras.
   */
  flush(options?: { leaving?: boolean }): Promise<void>
  stop(): void
}

export interface AutosaveOptions {
  /** Quiet period after the last change. */
  delayMs?: number
  /** Upper bound on how long continuous editing can postpone a save. */
  maxDelayMs?: number
  /** Window to attach page-hide flushing to; omit outside the browser. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export function startAutosave(
  editor: ProjectEditor,
  save: (project: Project, options: { leaving: boolean }) => Promise<void>,
  options: AutosaveOptions = {},
): AutosaveController {
  const delay = options.delayMs ?? 800
  const maxDelay = options.maxDelayMs ?? 5000
  let state: AutosaveState = { status: 'idle' }
  const listeners = new Set<(s: AutosaveState) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstPendingAt: number | undefined
  let dirty = false
  let inFlight: Promise<void> | undefined
  /** Whether the save in flight was started because the page is leaving. */
  let inFlightLeaving = false

  const set = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch }
    for (const l of listeners) l(state)
  }

  async function run(leaving = false): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = undefined
    firstPendingAt = undefined
    // A closing page may not live until a running save finishes (it can still be making a thumbnail), so leaving
    // writes the latest project right away instead of waiting behind it.
    while (inFlight && !leaving) {
      await inFlight
      if (!dirty) return
    }
    if (!dirty && !(leaving && inFlight)) return
    // beforeunload, visibilitychange and pagehide all fire on a tab close: one leaving save of the project is enough.
    if (!dirty && inFlightLeaving) {
      await inFlight
      return
    }
    dirty = false
    const project = editor.getProject()
    set({ status: 'saving' })
    const attempt: Promise<void> = save(project, { leaving }).then(
      () => {
        if (inFlight === attempt)
          set({ status: dirty ? 'pending' : 'saved', lastSavedAt: project.updatedAt, error: undefined })
      },
      (error: unknown) => {
        // A newer save holds everything this one had; if it fails too, it reports that itself.
        if (inFlight !== attempt) return
        dirty = true
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    inFlight = attempt
    inFlightLeaving = leaving
    await attempt
    if (inFlight !== attempt) return
    inFlight = undefined
    inFlightLeaving = false
    if (dirty && state.status === 'pending') schedule()
  }

  function schedule() {
    const now = Date.now()
    firstPendingAt ??= now
    if (timer) clearTimeout(timer)
    const wait = Math.max(0, Math.min(delay, firstPendingAt + maxDelay - now))
    timer = setTimeout(() => void run(), wait)
  }

  const unsubscribe = editor.subscribe((_project, change) => {
    if (change.source === 'load') return
    dirty = true
    if (state.status !== 'saving') set({ status: 'pending' })
    schedule()
  })

  const onHide = (e: Event) => {
    // Coming back to the page is not leaving it.
    if (e.type === 'visibilitychange' && globalThis.document?.visibilityState === 'visible') return
    if (dirty || inFlight) void run(true)
  }
  options.target?.addEventListener('pagehide', onHide)
  options.target?.addEventListener('visibilitychange', onHide)

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    flush: (o = {}) => run(o.leaving),
    stop() {
      if (timer) clearTimeout(timer)
      unsubscribe()
      options.target?.removeEventListener('pagehide', onHide)
      options.target?.removeEventListener('visibilitychange', onHide)
    },
  }
}
