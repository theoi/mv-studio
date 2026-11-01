import { pluginRegistry } from '../../engine/registry.ts'
import {
  clipsOnTrack,
  type Clip,
  type Easing,
  type Id,
  type Project,
  type Transition,
  type VisualClip,
} from '../../model/index.ts'
import { createTransition } from '../../plugins/library.ts'
import { formatTime } from '../format.ts'
import { undoAction } from './library.ts'
import { dispatch, editor, viewOf } from './project.ts'
import { get, select, toast, type Selection } from './ui.ts'

export type TransitionEdge = 'in' | 'out'

/** A transition on the timeline: where it sits and, at a cut, the clip it comes from. */
export interface TransitionSpot {
  clipId: Id
  edge: TransitionEdge
  transition: Transition
  start: number
  end: number
  /** For a transition into a clip that starts where another one ends: that clip. */
  fromId?: Id
}

const EPS = 1e-3
const DEFAULT_KIND = 'fade'

const visual = (c: Clip): c is VisualClip => 'transitionIn' in c || 'transform' in c

function byStart(project: Project, trackId: Id): VisualClip[] {
  return clipsOnTrack(project, trackId)
    .filter(visual)
    .sort((a, b) => a.start - b.start)
}

function clipEndingAt(clips: VisualClip[], time: number, not: Id): VisualClip | undefined {
  return clips.find((c) => c.id !== not && Math.abs(c.start + c.duration - time) < EPS)
}

export function transitionOf(clip: Clip | undefined, edge: TransitionEdge): Transition | undefined {
  if (!clip || !visual(clip)) return undefined
  return edge === 'in' ? clip.transitionIn : clip.transitionOut
}

/** Every transition on a track, in time order. */
export function transitionSpots(project: Project, trackId: Id): TransitionSpot[] {
  const clips = byStart(project, trackId)
  const spots: TransitionSpot[] = []
  for (const c of clips) {
    if (c.transitionIn) {
      const fromId = clipEndingAt(clips, c.start, c.id)?.id
      spots.push({
        clipId: c.id,
        edge: 'in',
        transition: c.transitionIn,
        start: c.start,
        end: c.start + c.transitionIn.duration,
        ...(fromId ? { fromId } : {}),
      })
    }
    if (c.transitionOut) {
      const end = c.start + c.duration
      spots.push({
        clipId: c.id,
        edge: 'out',
        transition: c.transitionOut,
        start: end - c.transitionOut.duration,
        end,
      })
    }
  }
  return spots
}

/** The cut without a transition at either end of a clip, the one nearer `time`; `clipId` is the clip after it. */
export function cutNear(
  project: Project,
  clip: { trackId: Id; start: number; end: number },
  time: number,
): { clipId: Id; time: number } | null {
  const cuts = bareCuts(project, clip.trackId).filter(
    (c) => Math.abs(c.time - clip.start) < 1e-3 || Math.abs(c.time - clip.end) < 1e-3,
  )
  cuts.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))
  return cuts[0] ?? null
}

/** Cuts without a transition: one clip ends where the next starts. `clipId` is the clip after the cut. */
export function bareCuts(project: Project, trackId: Id): { clipId: Id; time: number }[] {
  const clips = byStart(project, trackId)
  return clips
    .filter((c) => !c.transitionIn && clipEndingAt(clips, c.start, c.id))
    .map((c) => ({ clipId: c.id, time: c.start }))
}

/** The transitions at a clip's edges: its own in and out, and the next clip's in at a cut where this clip ends. */
export function transitionsAtClip(project: Project, clipId: Id): TransitionSpot[] {
  const clip = project.clips[clipId]
  if (!clip) return []
  return transitionSpots(project, clip.trackId).filter((s) => s.clipId === clipId || s.fromId === clipId)
}

/** How wide a transition's mark is on the timeline: its duration, and at least 24 px to click at any zoom. */
export const transitionMarkWidth = (duration: number, pps: number) => Math.max(24, duration * pps)

/** A transition's mark on the timeline, in px from the start of the lane. */
export interface PlacedMark extends TransitionSpot {
  left: number
  width: number
}

/**
 * The marks to draw for a track's transitions at this zoom, by the clip each belongs to. A mark that would overlap
 * one already placed is left out until zooming in spreads them apart; its transition stays reachable from the clip's
 * menu. The selected transition's mark is placed first, so it always shows.
 */
export function placeTransitionMarks(
  project: Project,
  trackId: Id,
  pps: number,
  selection: Selection,
): Map<Id, PlacedMark[]> {
  const marks = transitionSpots(project, trackId)
    .map((s) => {
      const width = transitionMarkWidth(s.end - s.start, pps)
      return { ...s, width, left: s.edge === 'in' ? s.start * pps : s.end * pps - width }
    })
    .sort((a, b) => a.left - b.left)
  const selected = (m: PlacedMark) =>
    selection.type === 'transition' && selection.id === m.clipId && selection.edge === m.edge
  const placed: PlacedMark[] = []
  for (const m of [...marks.filter(selected), ...marks.filter((m) => !selected(m))]) {
    if (placed.every((o) => m.left >= o.left + o.width || m.left + m.width <= o.left)) placed.push(m)
  }
  const byClip = new Map<Id, PlacedMark[]>()
  for (const m of placed) {
    const list = byClip.get(m.clipId)
    if (list) list.push(m)
    else byClip.set(m.clipId, [m])
  }
  return byClip
}

/** A transition's type as the timeline and inspector name it: "Fade". */
export const transitionName = (t: Transition) => pluginRegistry.get(t.kind)?.name ?? 'Transition'

/** A transition's duration as the inspector and the mark's tooltip show it: "0.6 s". */
export const transitionSeconds = (s: number) => `${Number(s.toFixed(2))} s`

/**
 * Focus goes to the clip on the timeline, which takes the selection when its transition is removed: the mark or
 * button that had focus is gone, and focus would drop to the page.
 */
export function focusClip(clipId: Id): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`)?.focus())
}

/** The longest a transition can be on this clip: half the clip, at most 4 s. */
export function maxTransitionDuration(clip: Clip): number {
  return Math.max(0.1, Math.min(4, clip.duration / 2))
}

function setTransition(
  clipId: Id,
  edge: TransitionEdge,
  value: Transition | undefined,
  options: { label?: string; coalesceKey?: string } = {},
): boolean {
  const path = [edge === 'in' ? 'transitionIn' : 'transitionOut']
  return dispatch({ type: 'clip.set', clipId, path, value }, options)
}

/** Puts the default transition on the cut before `clipId` and selects it, as one undo step. */
export function addTransitionAtCut(clipId: Id): void {
  const project = editor.getProject()
  const clip = project.clips[clipId]
  if (!clip || !visual(clip)) return
  const fresh = createTransition(DEFAULT_KIND)
  const value = { ...fresh, duration: Math.min(fresh.duration, maxTransitionDuration(clip)) }
  const name = pluginRegistry.get(DEFAULT_KIND)?.name ?? 'Transition'
  const label = `Add transition: ${name}`
  if (!setTransition(clipId, 'in', value, { label })) return
  select({ type: 'transition', id: clipId, edge: 'in' })
  toast(`“${name}” added to the cut at ${formatTime(clip.start, true)}`, undoAction(label))
}

/** Changes a transition's kind, keeping its duration and easing. */
export function changeTransitionKind(clipId: Id, edge: TransitionEdge, kind: string): void {
  const current = transitionOf(editor.getProject().clips[clipId], edge)
  if (!current || current.kind === kind) return
  const fresh = createTransition(kind)
  const name = pluginRegistry.get(kind)?.name ?? kind
  setTransition(
    clipId,
    edge,
    { ...fresh, duration: current.duration, easing: current.easing },
    { label: `Transition: ${name}` },
  )
}

/** Sets a transition's duration; slider edits coalesce until `editor.endGesture()`. */
export function setTransitionDuration(clipId: Id, edge: TransitionEdge, duration: number): void {
  const clip = editor.getProject().clips[clipId]
  const current = transitionOf(clip, edge)
  if (!clip || !current) return
  const value = { ...current, duration: Math.min(maxTransitionDuration(clip), Math.max(0.1, duration)) }
  setTransition(clipId, edge, value, {
    label: 'Transition duration',
    coalesceKey: `inspector:${clipId}:transition-${edge}:duration`,
  })
}

export function setTransitionEasing(clipId: Id, edge: TransitionEdge, easing: Easing): void {
  const current = transitionOf(editor.getProject().clips[clipId], edge)
  if (!current) return
  setTransition(clipId, edge, { ...current, easing }, { label: 'Transition easing' })
}

/**
 * Removes a transition as one undo step; when it was selected, its clip is selected and focused instead.
 */
export function removeTransition(clipId: Id, edge: TransitionEdge): void {
  const project = editor.getProject()
  const clip = project.clips[clipId]
  const current = transitionOf(clip, edge)
  if (!clip || !current) return
  const name = transitionName(current)
  const label = `Remove transition: ${name}`
  if (!setTransition(clipId, edge, undefined, { label })) return
  const selected = get().selection
  if (selected.type === 'transition' && selected.id === clipId && selected.edge === edge) {
    select({ type: 'clip', id: clipId })
    focusClip(clipId)
  }
  toast(`“${name}” removed from “${viewOf(project, clip).name}”`, undoAction(label))
}
