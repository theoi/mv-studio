import { create } from 'zustand'
import { editor } from './project.ts'
import { get, set, useUi } from './ui.ts'

/*
 * Pick mode: the preview takes one click (or Enter on its keyboard crosshair) as a point on the canvas for the
 * feature that asked, such as the object to put the lyrics behind. Pick mode is UI state only; `onPick` makes the
 * undoable edit.
 */

/** A point on the canvas, 0..1 from the top-left, at the playhead. */
export interface PickPoint {
  x: number
  y: number
  time: number
}

/** What a click at a point would pick. */
export interface PickTarget {
  /** Its outline, as canvas corners 0..1. */
  outline: [number, number][]
  /** Its name, announced to screen readers as the aim moves onto it. */
  name: string
}

export interface PickRequest {
  /** What to click, shown on the preview and used as its accessible name. */
  prompt: string
  onPick(point: PickPoint): void
  onCancel?(): void
  /** What a click at this point would pick, or null. */
  hover?(point: { x: number; y: number }): PickTarget | null
  /** Announced when the aim is on nothing `hover` would pick. Default "Nothing to pick here". */
  miss?: string
}

export const usePick = create<{ request: PickRequest | null }>(() => ({ request: null }))

/** Enters pick mode, pausing playback. A pick already in progress is cancelled. */
export function startPick(request: PickRequest): void {
  cancelPick()
  if (get().playing) set({ playing: false })
  usePick.setState({ request })
}

/** Leaves pick mode and tells the feature that asked. */
export function cancelPick(): void {
  const { request } = usePick.getState()
  if (!request) return
  usePick.setState({ request: null })
  request.onCancel?.()
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Picks a canvas point at the playhead and leaves pick mode first, so `onPick` may start the next pick. */
export function pickAt(x: number, y: number): void {
  const { request } = usePick.getState()
  if (!request) return
  usePick.setState({ request: null })
  request.onPick({ x: clamp01(x), y: clamp01(y), time: get().playhead })
}

useUi.subscribe((s, prev) => {
  if (!usePick.getState().request) return
  if (
    (s.playing && !prev.playing) ||
    (s.dialog !== null && s.dialog !== prev.dialog) ||
    (s.paletteOpen && !prev.paletteOpen) ||
    (s.guideStep !== null && prev.guideStep === null) ||
    s.screen !== prev.screen
  )
    cancelPick()
})

editor.subscribe((_project, change) => {
  if (change.source === 'load') cancelPick()
})
