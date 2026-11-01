import type { Project, SongSection } from '../../model/index.ts'
import { editor, sectionsOf, bpmOf, clampToLastFrame, hasSong } from './project.ts'
import { get, select, set } from './ui.ts'

/** Selects a song section and puts the playhead at its start; playback, if running, goes on from there. */
export function goToSection(s: SongSection) {
  select({ type: 'section', id: s.id })
  set({ playhead: s.start })
}

export function jumpSection(dir: 1 | -1) {
  const t = get().playhead
  const list = sectionsOf(editor.getProject())
  if (dir === 1) {
    const next = list.find((s) => s.start > t + 0.01)
    if (next) set({ playhead: next.start })
  } else {
    const prev = [...list].reverse().find((s) => s.start < t - 0.3)
    set({ playhead: prev ? prev.start : 0 })
  }
}

export function stepPlayhead(dir: 1 | -1, byBeat: boolean) {
  const p = editor.getProject()
  let t = get().playhead
  if (byBeat) {
    const beat = 60 / (bpmOf(p) ?? 120)
    t = (Math.round(t / beat) + dir) * beat
  } else t += dir / p.settings.fps
  set({ playhead: clampToLastFrame(p, t), playing: false })
}

/**
 * Where a scrub on the ruler puts the playhead: from the start to the last frame, or anywhere on an empty project's
 * ruler, which runs to `rulerEnd`.
 */
export function scrubTime(p: Project, t: number, rulerEnd: number): number {
  return hasSong(p) ? clampToLastFrame(p, t) : Math.min(rulerEnd, Math.max(0, t))
}
