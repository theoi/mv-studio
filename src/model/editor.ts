/**
 * ProjectEditor: holds the current immutable project, applies edit commands, and keeps undo/redo history as immer
 * patches (cheap for large projects). Works with React's useSyncExternalStore:
 *   const project = useSyncExternalStore(editor.subscribe, editor.getProject)
 */
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { applyCommand, describeCommand, EditError, type EditCommand } from './commands.ts'
import type { Project } from './types.ts'

enablePatches()

export interface DispatchOptions {
  /** Undo menu label; defaults to a description of the first command. */
  label?: string
  /**
   * Consecutive dispatches with the same key merge into one undo step (e.g. a slider drag or clip drag sending many
   * updates). Use a key unique to the gesture, such as `drag:${pointerId}:${clipId}`.
   */
  coalesceKey?: string
  /**
   * 'skip' applies the change (it is saved and exported like any other) without an undo step and without clearing
   * redo, for derived data written in the background, such as analysis results. Undo and redo restore exactly what
   * their own step recorded, so only use it for paths that undoable edits do not also change, or those edits will
   * overwrite it when they are undone or redone.
   */
  history?: 'record' | 'skip'
}

export interface EditChange {
  /** 'derived' is a dispatch with `history: 'skip'`. */
  source: 'edit' | 'derived' | 'undo' | 'redo' | 'load'
  /** Commands applied (empty for undo/redo/load). */
  commands: EditCommand[]
  patches: Patch[]
  /** On 'load', the history of the project that was replaced, to save with it. */
  replaced?: SavedHistory
}

interface HistoryEntry {
  label: string
  commands: EditCommand[]
  patches: Patch[]
  inversePatches: Patch[]
  coalesceKey?: string
}

/** An undo or redo step as plain data, kept with the saved project. */
export interface SavedStep {
  label: string
  patches: Patch[]
  inversePatches: Patch[]
}

/**
 * The undo and redo steps of a project as saved with it, so they survive a reload or a crash. `updatedAt` is the
 * project's when they were taken: they apply only to that very version of it.
 */
export interface SavedHistory {
  updatedAt: string
  /** Oldest first, as the stacks are. */
  undo: SavedStep[]
  redo: SavedStep[]
}

/** How much history is saved with a project: the most recent steps, within a step count and a rough size. */
const SAVED_STEPS = 100
const SAVED_BYTES = 2_000_000

type Listener = (project: Project, change: EditChange) => void

/**
 * The project takes ownership of objects inside commands (e.g. the clip of clip.add) and immer deep-freezes them, so
 * dispatch works on a copy: callers may reuse, re-dispatch or mutate their command objects afterwards.
 */
function cloneCommands(commands: EditCommand[]): EditCommand[] {
  try {
    return structuredClone(commands)
  } catch {
    throw new EditError('invalid', 'Edit commands must be plain, serializable data')
  }
}

function pathsOverlap(a: Patch['path'], b: Patch['path']): boolean {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

export class ProjectEditor {
  private project: Project
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private readonly listeners = new Set<Listener>()
  private readonly historyLimit: number
  private readonly now: () => Date
  /** Rough JSON size of each step, measured once. */
  private readonly stepBytes = new WeakMap<HistoryEntry, number>()

  constructor(project: Project, options: { historyLimit?: number; now?: () => Date } = {}) {
    this.project = project
    this.historyLimit = options.historyLimit ?? 500
    this.now = options.now ?? (() => new Date())
  }

  /** Current project (immutable; a new object after every change). Bound for useSyncExternalStore. */
  getProject = (): Project => this.project

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Applies one or more commands as a single undo step. Throws EditError (and changes nothing) if any is invalid. */
  dispatch(commands: EditCommand | EditCommand[], options: DispatchOptions = {}): void {
    const list = cloneCommands(Array.isArray(commands) ? commands : [commands])
    if (list.length === 0) return
    const stamp = this.now().toISOString()
    const [next, patches, inversePatches] = produceWithPatches(this.project, (draft) => {
      for (const cmd of list) applyCommand(draft, cmd)
      draft.updatedAt = stamp
    })
    if (patches.length === 0) return
    if (options.history === 'skip') {
      if (import.meta.env.DEV) this.warnOnHistoryOverlap(list, patches)
      this.project = next
      this.emit({ source: 'derived', commands: list, patches })
      return
    }

    const last = this.undoStack[this.undoStack.length - 1]
    if (options.coalesceKey && last?.coalesceKey === options.coalesceKey && this.redoStack.length === 0) {
      last.commands.push(...list)
      last.patches.push(...patches)
      last.inversePatches = [...inversePatches, ...last.inversePatches]
    } else {
      this.undoStack.push({
        label: options.label ?? describeCommand(list[0] as EditCommand),
        commands: [...list],
        patches,
        inversePatches,
        coalesceKey: options.coalesceKey,
      })
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift()
    }
    this.redoStack = []
    this.project = next
    this.emit({ source: 'edit', commands: list, patches })
  }

  /**
   * Development check for `history: 'skip'`: warns when a derived write touches a path that undo (its inverse patches)
   * or redo (its patches) would later overwrite.
   */
  private warnOnHistoryOverlap(commands: EditCommand[], patches: Patch[]) {
    const written = patches.filter((p) => p.path[0] !== 'updatedAt')
    const applied = [
      ...this.undoStack.flatMap((e) => e.inversePatches.map((p) => [e, p] as const)),
      ...this.redoStack.flatMap((e) => e.patches.map((p) => [e, p] as const)),
    ]
    for (const [entry, recorded] of applied) {
      // Removals follow their owner's lifetime: undoing or redoing one drops derived data together with its owner.
      if (recorded.op === 'remove') continue
      const hit = written.find((p) => pathsOverlap(p.path, recorded.path))
      if (hit) {
        console.warn(
          `Derived edit ${commands[0]?.type} writes ${hit.path.join('.')}, which the undo step "${entry.label}" also changes`,
        )
        return
      }
    }
  }
  /** Ends coalescing so the next dispatch with the same key starts a new undo step (call on pointerup). */
  endGesture(): void {
    const last = this.undoStack[this.undoStack.length - 1]
    if (last) delete last.coalesceKey
  }

  /**
   * Takes back the gesture still being coalesced under `key`, such as a drag that ends where it cannot drop: its edits
   * are reverted and it leaves no undo step. Returns false when the last undo step is not that gesture.
   */
  cancelGesture(key: string): boolean {
    const last = this.undoStack[this.undoStack.length - 1]
    if (!last || last.coalesceKey !== key) return false
    this.undoStack.pop()
    this.project = applyPatches(this.project, last.inversePatches)
    this.emit({ source: 'undo', commands: [], patches: last.inversePatches })
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }

  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  /** Labels of the undo and redo steps, the next one to undo or redo first. */
  history(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack.map((e) => e.label).reverse(),
      redo: this.redoStack.map((e) => e.label).reverse(),
    }
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    delete entry.coalesceKey
    this.project = applyPatches(this.project, entry.inversePatches)
    this.redoStack.push(entry)
    this.emit({ source: 'undo', commands: [], patches: entry.inversePatches })
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.project = applyPatches(this.project, entry.patches)
    this.undoStack.push(entry)
    this.emit({ source: 'redo', commands: [], patches: entry.patches })
    return true
  }

  /**
   * The history to save with the current project: the most recent undo and redo steps, at most SAVED_STEPS of each
   * and SAVED_BYTES of patches in all, the next to undo kept first.
   */
  savedHistory(): SavedHistory {
    let bytes = 0
    const keep = (stack: HistoryEntry[]): SavedStep[] => {
      const kept: SavedStep[] = []
      for (let i = stack.length - 1; i >= 0 && kept.length < SAVED_STEPS; i--) {
        const entry = stack[i] as HistoryEntry
        let size = this.stepBytes.get(entry)
        if (size === undefined) {
          size = JSON.stringify([entry.patches, entry.inversePatches]).length
          this.stepBytes.set(entry, size)
        }
        if (bytes + size > SAVED_BYTES) break
        bytes += size
        kept.unshift({ label: entry.label, patches: entry.patches, inversePatches: entry.inversePatches })
      }
      return kept
    }
    const undo = keep(this.undoStack)
    return { updatedAt: this.project.updatedAt, undo, redo: keep(this.redoStack) }
  }

  /**
   * Replaces the whole project (open/new). Its history is cleared, or restored from `history` when that was saved
   * with this very version of the project.
   */
  load(project: Project, history?: SavedHistory): void {
    const restore = history?.updatedAt === project.updatedAt ? history : undefined
    const entries = (steps: SavedStep[] = []) =>
      steps.map((s) => ({
        label: s.label,
        commands: [],
        patches: s.patches,
        inversePatches: s.inversePatches,
      }))
    const replaced = this.savedHistory()
    this.project = project
    this.undoStack = entries(restore?.undo)
    this.redoStack = entries(restore?.redo)
    this.emit({ source: 'load', commands: [], patches: [], replaced })
  }

  private emit(change: EditChange) {
    for (const listener of this.listeners) listener(this.project, change)
  }
}
