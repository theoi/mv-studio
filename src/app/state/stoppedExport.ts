/**
 * Tells the user that the last export didn't finish because its tab died (found by exports.ts at start). Reopened
 * into its project's Export dialog, the dialog says it (StoppedExportNote) until the next export starts. Anywhere else
 * a toast says it until dismissed, and when another project or the start screen is showing, it names the project and
 * opens it in Export.
 */
import { findStoppedExport, exportStoppedMessage, useStoppedExport } from './exports.ts'
import { openProject, usePersistence } from './persistence.ts'
import { editor } from './project.ts'
import { dismissToast, get, set, toast, useUi, type UiState } from './ui.ts'

const TOAST_KEY = 'export-stopped'

/** Resolves once the project the app reopens at start (the last one, or a link's) is open. */
function restored(): Promise<void> {
  return new Promise((resolve) => {
    if (!usePersistence.getState().restoring) return resolve()
    const off = usePersistence.subscribe((s) => {
      if (s.restoring) return
      off()
      resolve()
    })
  })
}

async function openInExport(id: string): Promise<void> {
  await openProject(id)
  if (editor.getProject().id === id) set({ dialog: 'export', exportPhase: 'setup' })
}

export async function reportStoppedExport(): Promise<void> {
  const stopped = await findStoppedExport()
  if (!stopped) return
  await restored()
  if (useStoppedExport.getState().stopped !== stopped) return
  const { project, resolution, files } = stopped
  const showing = (s: UiState) => s.screen === 'editor' && editor.getProject().id === project?.id
  const inDialog = (s: UiState) => showing(s) && s.dialog === 'export'
  if (inDialog(get())) return
  if (!project || showing(get()))
    toast(exportStoppedMessage(resolution, undefined, files), undefined, { key: TOAST_KEY, sticky: true })
  else
    toast(
      exportStoppedMessage(resolution, project.name, files),
      project.kept ? { label: 'Open', run: () => void openInExport(project.id) } : undefined,
      { key: TOAST_KEY, sticky: true },
    )
  // Once the project's Export dialog opens, it says it instead.
  const off = useUi.subscribe((s) => {
    if (!inDialog(s)) return
    off()
    const shown = s.toasts.find((t) => t.key === TOAST_KEY)
    if (shown) dismissToast(shown.id)
  })
}
