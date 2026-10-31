import { dispatch, editor } from './project.ts'
import { get, selectClips, set, toast } from './ui.ts'

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
 * removed since are left out. `openInspector: false` keeps the right panel where it is, so a Show button there keeps
 * its focus.
 */
export function showClips(clipIds: readonly string[], { openInspector = true } = {}): void {
  const { clips, tracks } = editor.getProject()
  const live = clipIds.filter((id) => clips[id])
  if (!live.length) {
    toast(
      clipIds.length === 1
        ? 'That clip is no longer in the project'
        : 'Those clips are no longer in the project',
    )
    return
  }
  const tab = get().rightTab
  selectClips(live)
  if (!openInspector) set({ rightTab: tab })
  revealClips(live)

  const onTracks = new Set(live.map((id) => clips[id]?.trackId))
  const hidden = tracks.filter((t) => t.hidden && onTracks.has(t.id))
  if (!hidden.length) return
  const all = live.every((id) => hidden.some((t) => t.id === clips[id]?.trackId))
  const where = hidden.length === 1 ? 'on a hidden track' : 'on hidden tracks'
  const message = !all ? `Some are ${where}` : live.length === 1 ? `It’s ${where}` : `They’re ${where}`
  toast(message, {
    label: hidden.length === 1 ? 'Show track' : 'Show tracks',
    run: () => {
      const still = editor.getProject().tracks.filter((t) => t.hidden && hidden.some((h) => h.id === t.id))
      if (!still.length) return
      dispatch(
        still.map((t) => ({ type: 'track.update' as const, trackId: t.id, patch: { hidden: false } })),
        { label: still.length === 1 ? `Show ${still[0]!.name}` : 'Show tracks' },
      )
    },
  })
}
