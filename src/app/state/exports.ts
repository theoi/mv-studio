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

interface RunningMark {
  height?: unknown
  lock?: unknown
}

/** What the next visit says when an export stopped because its tab died, by the tallest output's height. */
export function exportStoppedMessage(height: number): string {
  return height > 720
    ? 'The last export stopped unexpectedly, maybe because the browser ran out of memory. Try a lower resolution.'
    : 'The last export stopped unexpectedly, maybe because the browser ran out of memory. Close other tabs and try again.'
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

/**
 * Marks an export as running until `done` settles. A tab that dies first (a crash, or the browser running out of
 * memory) fires no event, so the mark stays and the next visit says the export stopped (reportStoppedExport). A page
 * closed or reloaded on purpose clears it.
 */
export function markExportRunning(height: number, done: Promise<unknown>): void {
  const lock = `${EXPORT_LOCK}${crypto.randomUUID()}`
  const onPageHide = () => clearMark(lock)
  // Marked only while the lock is held, and cleared before it is released, so another tab never sees the mark of a
  // running export without its lock.
  const run = async () => {
    try {
      localStorage.setItem(RUNNING_KEY, JSON.stringify({ height, lock }))
    } catch {
      return
    }
    window.addEventListener('pagehide', onPageHide)
    await done.catch(() => undefined)
    window.removeEventListener('pagehide', onPageHide)
    clearMark(lock)
  }
  if (navigator.locks) void navigator.locks.request(lock, run)
  else void run()
}

/** Says once that the last export stopped, when its tab died while it ran. */
export async function reportStoppedExport(): Promise<void> {
  const mark = readMark()
  if (mark === null) return
  if (navigator.locks && typeof mark.lock === 'string') {
    const { held = [] } = await navigator.locks.query()
    // An export running in another tab holds its lock: its mark is not of a stopped export.
    if (held.some((l) => l.name === mark.lock)) return
    if (readMark()?.lock !== mark.lock) return
  }
  clearMark()
  toast(exportStoppedMessage(Number(mark.height) || 0), undefined, { key: 'export-stopped' })
}
