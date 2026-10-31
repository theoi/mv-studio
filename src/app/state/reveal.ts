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
