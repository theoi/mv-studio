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
}

interface HistoryEntry {
  label: string
  commands: EditCommand[]
  patches: Patch[]
  inversePatches: Patch[]
  coalesceKey?: string
}

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

  /** Replaces the whole project (open/new) and clears history. */
  load(project: Project): void {
    this.project = project
    this.undoStack = []
    this.redoStack = []
    this.emit({ source: 'load', commands: [], patches: [] })
  }

  private emit(change: EditChange) {
    for (const listener of this.listeners) listener(this.project, change)
  }
}
