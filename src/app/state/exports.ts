import { create } from 'zustand'
import type { AspectPreset } from '../../model/index.ts'
import { set, toast } from './ui.ts'

/*
 * The latest export as the exporting view shows it: one job that renders several files in order. Kept outside the
 * dialog so the view can be reopened from the activity indicator, and free of src/export so the design preview's
 * mock export does not pull the export code into the main bundle.
 */

export interface ExportRow {
  id: string
  title: string
  aspect: AspectPreset
  /** Frames to render: the row's share of the job's progress. */
  frames: number
}

interface ExportsState {
  jobId: string | null
  rows: ExportRow[]
  /** Finished files by row id. */
  files: Record<string, File>
  /** The song section the export dialog opens with a teaser of (Section › Export as a teaser). */
  teaserSection: string | null
  /** The output the export dialog opens with, added and selected (the palette's Export a vertical version…). */
  preset: ExportPreset | null
}

export type ExportPreset = 'vertical' | 'teaser' | 'loop'

export const useExports = create<ExportsState>(() => ({
  jobId: null,
  rows: [],
  files: {},
  teaserSection: null,
  preset: null,
}))

/** Opens the export dialog with a chorus teaser that starts on a song section, selected. */
export function exportSectionTeaser(sectionId: string): void {
  useExports.setState({ teaserSection: sectionId })
  set({ dialog: 'export', exportPhase: 'setup' })
}

/** Opens the export dialog with an output of this kind in its list, turned on and selected. */
export function exportWithOutput(preset: ExportPreset): void {
  useExports.setState({ preset })
  set({ dialog: 'export', exportPhase: 'setup' })
}

/** Shows a job in the exporting view. */
export function showExport(jobId: string, rows: ExportRow[]): void {
  useExports.setState({ jobId, rows, files: {} })
}

export function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // The download holds its own reference once it starts.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Downloads a finished file again (it stays in browser storage until the next export replaces it). */
export function downloadAgain(rowId: string): void {
  const file = useExports.getState().files[rowId]
  if (file) downloadFile(file, file.name)
  else toast('That file is no longer available. Export it again.')
}

const RUNNING_KEY = 'mv-studio.export-running'
/**
 * Prefix of the lock a tab holds while it runs an export, one per export, named in its mark: another tab of the
 * studio then doesn't take an export that is still running for one that stopped.
 */
const EXPORT_LOCK = 'mv-studio.export:'
/** Held while a tab checks for a stopped export, so tabs restored together after a crash find it once. */
const REPORT_LOCK = 'mv-studio.export-report'

/** The project of an export, as its mark keeps it. */
export interface ExportProject {
  id: string
  name: string
  /** Kept in this browser, so it can be opened again. */
  kept: boolean
}

/** An export whose tab died while it ran. */
export interface StoppedExport {
  /** Null for a mark that doesn't name it. */
  project: ExportProject | null
  resolution: number
}

/** The export found stopped at start (findStoppedExport), until the next export starts. */
export const useStoppedExport = create<{ stopped: StoppedExport | null }>(() => ({ stopped: null }))

interface RunningMark {
  resolution?: unknown
  lock?: unknown
  project?: unknown
}

/**
 * An export's resolution as the dialog names it (720p is 720): the largest short side of its outputs, since a 720p
 * Vertical output is 720 × 1280.
 */
export function exportResolution(sizes: readonly { width: number; height: number }[]): number {
  return Math.max(0, ...sizes.map((s) => Math.min(s.width, s.height)))
}

/**
 * Says that an export didn't finish because its tab died, with what may help at its resolution, and names its
 * project when that isn't the one showing.
 */
export function exportStoppedMessage(resolution: number, projectName?: string): string {
  const which = projectName === undefined ? 'The last export' : `The export of “${projectName}”`
  const advice = resolution > 720 ? 'Try a lower resolution.' : 'Close other tabs and try again.'
  return `${which} didn’t finish. The browser may have run out of memory. ${advice}`
}

/** Web Locks, without which a tab can't tell an export running in another tab from one that stopped. */
function locks(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks
}

function readMark(): RunningMark | null {
  try {
    const mark = localStorage.getItem(RUNNING_KEY)
    if (mark === null) return null
    try {
      return (JSON.parse(mark) as RunningMark | null) ?? {}
    } catch {
      // A mark that can't be read still means an export stopped.
      return {}
    }
  } catch {
    return null
  }
}

/** Removes the mark, only if it is still that of export `lock` (a later export, in another tab, may have marked). */
function clearMark(lock?: string): void {
  try {
    if (lock === undefined || readMark()?.lock === lock) localStorage.removeItem(RUNNING_KEY)
  } catch {
    // Storage unavailable: nothing was marked.
  }
}

function markedProject(mark: RunningMark): ExportProject | null {
  const p = mark.project as Partial<Record<keyof ExportProject, unknown>> | null | undefined
  return p && typeof p.id === 'string' && typeof p.name === 'string'
    ? { id: p.id, name: p.name, kept: p.kept === true }
    : null
}

/**
 * Marks an export as running until `done` settles. A tab that dies first (a crash, or the browser running out of
 * memory) fires no event, so the mark stays and the next visit finds the export stopped (findStoppedExport). A page
 * closed or reloaded on purpose clears it.
 */
export function markExportRunning(resolution: number, project: ExportProject, done: Promise<unknown>): void {
  useStoppedExport.setState({ stopped: null })
  const manager = locks()
  if (!manager) return
  const lock = `${EXPORT_LOCK}${crypto.randomUUID()}`
  const onPageHide = () => clearMark(lock)
  // Marked only while the lock is held, and cleared before it is released, so another tab never sees the mark of a
  // running export without its lock.
  const run = async () => {
    try {
      localStorage.setItem(RUNNING_KEY, JSON.stringify({ resolution, lock, project }))
    } catch {
      return
    }
    window.addEventListener('pagehide', onPageHide)
    await done.catch(() => undefined)
    window.removeEventListener('pagehide', onPageHide)
    clearMark(lock)
  }
  manager.request(lock, run).catch(() => undefined)
}

/**
 * The last export, when its tab died while it ran. Found once: the mark it left is removed, and the export is kept in
 * useStoppedExport until the next one starts.
 */
export async function findStoppedExport(): Promise<StoppedExport | null> {
  const manager = locks()
  if (!manager || readMark() === null) return null
  try {
    return await manager.request(REPORT_LOCK, async () => {
      const mark = readMark()
      if (mark === null) return null
      if (typeof mark.lock === 'string') {
        const { held = [] } = await manager.query()
        // An export running in another tab holds its lock: its mark is not of a stopped export.
        if (held.some((l) => l.name === mark.lock)) return null
        if (readMark()?.lock !== mark.lock) return null
      }
      clearMark()
      const stopped = { project: markedProject(mark), resolution: Number(mark.resolution) || 0 }
      useStoppedExport.setState({ stopped })
      return stopped
    })
  } catch {
    // Web Locks refused here (a sandboxed frame): nothing is found.
    return null
  }
}
