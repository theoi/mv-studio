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
  /** Saves any pending change now and resolves when it is written. */
  flush(): Promise<void>
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
  save: (project: Project) => Promise<void>,
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

  const set = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch }
    for (const l of listeners) l(state)
  }

  async function run(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = undefined
    firstPendingAt = undefined
    if (inFlight) {
      await inFlight
      if (!dirty) return
    }
    if (!dirty) return
    dirty = false
    const project = editor.getProject()
    set({ status: 'saving' })
    inFlight = save(project).then(
      () => set({ status: dirty ? 'pending' : 'saved', lastSavedAt: project.updatedAt, error: undefined }),
      (error: unknown) => {
        dirty = true
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    await inFlight
    inFlight = undefined
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

  const onHide = () => {
    if (dirty) void run()
  }
  options.target?.addEventListener('pagehide', onHide)
  options.target?.addEventListener('visibilitychange', onHide)

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    flush: () => run(),
    stop() {
      if (timer) clearTimeout(timer)
      unsubscribe()
      options.target?.removeEventListener('pagehide', onHide)
      options.target?.removeEventListener('visibilitychange', onHide)
    },
  }
}
