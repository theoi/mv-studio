import { create } from 'zustand'
import type { AspectPreset } from '../../model/index.ts'
import { jobs, type JobSnapshot } from '../../shared/jobs.ts'
import { dismissToast, get, set, toast } from './ui.ts'

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
  /** The file's estimated export time, which the job's time left counts for it until it renders. */
  seconds?: number
}

interface ExportsState {
  jobId: string | null
  /** The export's job as last seen. Kept once it ends, when the job list may have dropped it for newer jobs. */
  job: JobSnapshot | null
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
  job: null,
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

let unfollow = (): void => undefined

/** Shows a job in the exporting view, which follows it until the next export. */
export function showExport(jobId: string, rows: ExportRow[]): void {
  unfollow()
  dismissExportEnd()
  const handle = jobs.get(jobId)
  useExports.setState({ jobId, job: handle?.snapshot() ?? null, rows, files: {} })
  unfollow = handle?.subscribe((job) => useExports.setState({ job })) ?? (() => undefined)
}

const EXPORT_END = 'export-end'

function dismissExportEnd(): void {
  const end = get().toasts.find((t) => t.key === EXPORT_END)
  if (end) dismissToast(end.id)
}

/** Opens the export dialog on the latest export: how it ended, and its files to download again. */
export function showLastExport(): void {
  dismissExportEnd()
  set({ dialog: 'export', exportPhase: 'exporting' })
}

/**
 * Says how an export ended. While the export dialog shows the export, it says so itself; otherwise the user may be in
 * another tab, so the toast stays (unless `sticky` is false) with Show, and Download for a single file (`rowId`).
 */
export function toastExportEnd(
  message: string,
  { rowId, sticky = true }: { rowId?: string; sticky?: boolean } = {},
) {
  const { dialog, exportPhase } = get()
  if (dialog === 'export' && exportPhase === 'exporting') {
    toast(message)
    return
  }
  const download = rowId ? { label: 'Download', run: () => downloadAgain(rowId) } : undefined
  toast(message, download, { show: showLastExport, key: EXPORT_END, sticky })
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

/** Downloads a finished file again (it stays in memory until the next export or a reload). */
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

/** Of an export of several files, how many were saved to Downloads before it stopped. */
export interface SavedFiles {
  saved: number
  total: number
}

/** An export whose tab died while it ran. */
export interface StoppedExport {
  /** Null for a mark that doesn't name it. */
  project: ExportProject | null
  resolution: number
  /** Null unless some files of several were saved. */
  files: SavedFiles | null
}

/** The export found stopped at start (findStoppedExport), until the next export starts. */
export const useStoppedExport = create<{ stopped: StoppedExport | null }>(() => ({ stopped: null }))

interface RunningMark {
  resolution?: unknown
  lock?: unknown
  project?: unknown
  files?: unknown
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
 * project when that isn't the one showing. Files it saved before are counted, so they aren't exported again.
 */
export function exportStoppedMessage(
  resolution: number,
  projectName?: string,
  files?: SavedFiles | null,
): string {
  const which = projectName === undefined ? 'The last export' : `The export of “${projectName}”`
  const saved = files
    ? ` ${files.saved} of ${files.total} files ${files.saved === 1 ? 'was' : 'were'} saved to Downloads.`
    : ''
  const advice = resolution > 720 ? 'Try a lower resolution.' : 'Close other tabs and try again.'
  return `${which} didn’t finish.${saved} The browser may have run out of memory. ${advice}`
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

function markedFiles(mark: RunningMark): SavedFiles | null {
  const f = mark.files as Partial<Record<keyof SavedFiles, unknown>> | null | undefined
  const saved = Number(f?.saved)
  const total = Number(f?.total)
  return Number.isInteger(saved) && Number.isInteger(total) && saved > 0 && saved < total
    ? { saved, total }
    : null
}

function markedProject(mark: RunningMark): ExportProject | null {
  const p = mark.project as Partial<Record<keyof ExportProject, unknown>> | null | undefined
  return p && typeof p.id === 'string' && typeof p.name === 'string'
    ? { id: p.id, name: p.name, kept: p.kept === true }
    : null
}

/**
 * Marks an export of `total` files as running until `done` settles. A tab that dies first (a crash, or the browser
 * running out of memory) fires no event, so the mark stays and the next visit finds the export stopped
 * (findStoppedExport). A page closed or reloaded on purpose clears it. Returns what to call with the number of files
 * saved so far, each time one is.
 */
export function markExportRunning(
  resolution: number,
  project: ExportProject,
  done: Promise<unknown>,
  total = 1,
): (saved: number) => void {
  useStoppedExport.setState({ stopped: null })
  const manager = locks()
  if (!manager) return () => undefined
  const lock = `${EXPORT_LOCK}${crypto.randomUUID()}`
  let saved = 0
  let marked = false
  const write = () => {
    try {
      localStorage.setItem(
        RUNNING_KEY,
        JSON.stringify({ resolution, lock, project, files: { saved, total } }),
      )
      return true
    } catch {
      return false
    }
  }
  const onPageHide = () => clearMark(lock)
  // Marked only while the lock is held, and cleared before it is released, so another tab never sees the mark of a
  // running export without its lock.
  const run = async () => {
    if (!write()) return
    marked = true
    window.addEventListener('pagehide', onPageHide)
    await done.catch(() => undefined)
    window.removeEventListener('pagehide', onPageHide)
    marked = false
    clearMark(lock)
  }
  manager.request(lock, run).catch(() => undefined)
  return (count) => {
    saved = count
    // Before the lock is granted, the mark is first written with the count. A later export may have marked instead.
    if (marked && readMark()?.lock === lock) write()
  }
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
      const stopped = {
        project: markedProject(mark),
        resolution: Number(mark.resolution) || 0,
        files: markedFiles(mark),
      }
      useStoppedExport.setState({ stopped })
      return stopped
    })
  } catch {
    // Web Locks refused here (a sandboxed frame): nothing is found.
    return null
  }
}
