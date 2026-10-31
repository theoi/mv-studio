import { create } from 'zustand'
import type { AspectPreset } from '../../model/index.ts'
import { toast } from './ui.ts'

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
}

export const useExports = create<ExportsState>(() => ({ jobId: null, rows: [], files: {} }))

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
