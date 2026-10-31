import { editor } from './project.ts'
import { selectClips, toast } from './ui.ts'

/**
 * Scrolling the timeline to clips that an edit added where the user may not see them (paste, duplicate). The timeline
 * registers how it scrolls while it is showing.
 */
let reveal: ((clipIds: readonly string[]) => void) | null = null

/** Returns the unregister function. */
export function registerReveal(fn: (clipIds: readonly string[]) => void): () => void {
  reveal = fn
  return () => {
    if (reveal === fn) reveal = null
  }
}

export function revealClips(clipIds: readonly string[]): void {
  reveal?.(clipIds)
}

/**
 * Selects clips that an automatic or AI tool just made and scrolls the timeline to them, for a result's "Show". Clips
 * removed since are left out.
 */
export function showClips(clipIds: readonly string[]): void {
  const { clips } = editor.getProject()
  const live = clipIds.filter((id) => clips[id])
  if (!live.length) {
    toast('Those clips are no longer in the project')
    return
  }
  selectClips(live)
  revealClips(live)
}
