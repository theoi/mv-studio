import { create } from 'zustand'

interface Waiting {
  key: string
  /** A standing hint, not about the selection (e.g. lines not timed yet). */
  ambient: boolean
}

/**
 * Inline suggestions that want to show, in the order they asked. Only one shows: the first one about the selection,
 * else the first standing one. So a standing hint gives way to a suggestion about what the user just selected and
 * comes back after it, while a newer suggestion never replaces one of its own kind on screen.
 */
export const useSuggestionQueue = create<{ waiting: Waiting[] }>(() => ({ waiting: [] }))

/** Puts a suggestion in line; the returned function takes it out. */
export function joinSuggestionQueue(key: string, ambient = false): () => void {
  useSuggestionQueue.setState((s) =>
    s.waiting.some((w) => w.key === key) ? s : { waiting: [...s.waiting, { key, ambient }] },
  )
  return () => useSuggestionQueue.setState((s) => ({ waiting: s.waiting.filter((w) => w.key !== key) }))
}

export function hasSuggestionTurn(key: string, waiting = useSuggestionQueue.getState().waiting): boolean {
  return (waiting.find((w) => !w.ambient) ?? waiting[0])?.key === key
}
