import type { Project } from '../../model/index.ts'
import { editor, hasSong, sectionName, sectionsOf, timelineDuration } from './project.ts'
import { get, set, toast, type PreviewZoom } from './ui.ts'

/*
 * The preview's own controls: loop, zoom and full screen. Volume is a preference (prefs().previewVolume) because it
 * belongs to the device, not the project.
 */

/** Zoom levels offered besides Fit, as a fraction of the project's pixels. */
export const PREVIEW_ZOOMS: readonly number[] = [0.25, 0.5, 1, 2]

export function zoomLabel(zoom: PreviewZoom): string {
  return zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`
}

/** What loop playback repeats with the playhead at t: the section there, or the whole video. */
export function loopRange(project: Project, t: number): { start: number; end: number; label?: string } {
  const section = sectionsOf(project).find((s) => t >= s.start && t < s.end)
  if (section) return { start: section.start, end: section.end, label: sectionName(section) }
  return { start: 0, end: timelineDuration(project) }
}

export function toggleLoop() {
  const project = editor.getProject()
  if (!hasSong(project)) return
  const loop = !get().loop
  set({ loop })
  if (!loop) {
    toast('Loop off')
    return
  }
  const { label } = loopRange(project, get().playhead)
  toast(label ? `Looping ${label}` : 'Looping the whole video')
}

let fullscreenTarget: HTMLElement | null = null

/** The element full screen shows: the preview stage, while one is mounted. */
export function setFullscreenTarget(el: HTMLElement | null) {
  fullscreenTarget = el
}

export function isFullscreen(el: Element | null): boolean {
  return !!el && document.fullscreenElement === el
}

export function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange)
  return () => document.removeEventListener('fullscreenchange', onChange)
}

export function toggleFullscreen() {
  if (document.fullscreenElement) {
    void document.exitFullscreen()
    return
  }
  const el = fullscreenTarget
  if (!el || !hasSong(editor.getProject())) return
  el.requestFullscreen().then(
    // Keys go to the focused element, which would otherwise stay on the button outside the full-screen stage.
    () => el.focus({ preventScroll: true }),
    () => toast('This browser window can’t go full screen.'),
  )
}
