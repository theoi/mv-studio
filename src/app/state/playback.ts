import { editor, sectionsOf, bpmOf, timelineDuration } from './project.ts'
import { get, set } from './ui.ts'

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
  set({ playhead: Math.min(timelineDuration(p), Math.max(0, t)), playing: false })
}
