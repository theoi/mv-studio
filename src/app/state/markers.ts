/**
 * Song markers: named flags on the timeline ruler. M or the toolbar's flag adds one at the playhead; dragging, renaming
 * and removing go through edit commands, one undo step each.
 */
import { newId, type Marker } from '../../model/index.ts'
import { formatTime } from '../format.ts'
import { dispatch, editor, timelineDuration, undo } from './project.ts'
import { get, toast } from './ui.ts'

/** Markers closer than this are at the same place, so M twice does not stack two flags. */
const SAME_PLACE = 0.05
/** Nudges closer together than this are one undo step. */
const NUDGE_PAUSE_MS = 800
const SNAP_PX = 8

/** "Marker 1", "Marker 2": the lowest number no marker is named with. */
export function nextMarkerName(markers: readonly Marker[]): string {
  const names = new Set(markers.map((m) => m.label))
  let n = 1
  while (names.has(`Marker ${n}`)) n++
  return `Marker ${n}`
}

/** Adds a marker at the playhead, or points out the one already there. Returns the marker's id. */
export function addMarkerAtPlayhead(): string | null {
  const markers = editor.getProject().markers
  const time = get().playhead
  const there = markers.find((m) => Math.abs(m.time - time) < SAME_PLACE)
  if (there) {
    toast(`${there.label} is already at ${formatTime(there.time, true)}`)
    return there.id
  }
  const marker: Marker = { id: newId(), time, kind: 'user', label: nextMarkerName(markers) }
  if (!dispatch({ type: 'marker.add', marker }, { label: 'Add marker' })) return null
  toast(`Added ${marker.label} at ${formatTime(time, true)}`, { label: 'Undo', run: undo })
  return marker.id
}

/** Moves a marker, kept within the timeline. A drag passes `gesture` so all its moves are one undo step. */
export function moveMarker(id: string, time: number, gesture = false): void {
  const p = editor.getProject()
  const marker = p.markers.find((m) => m.id === id)
  if (!marker) return
  const t = Math.min(timelineDuration(p), Math.max(0, time))
  if (Math.abs(t - marker.time) < 1e-6) return
  dispatch(
    { type: 'marker.update', markerId: id, patch: { time: t } },
    { label: 'Move marker', ...(gesture ? { coalesceKey: `marker:${id}` } : {}) },
  )
}

export function renameMarker(id: string, label: string): void {
  const name = label.trim()
  const marker = editor.getProject().markers.find((m) => m.id === id)
  if (!marker || !name || name === marker.label) return
  dispatch({ type: 'marker.update', markerId: id, patch: { label: name } }, { label: 'Rename marker' })
}

export function removeMarker(id: string): void {
  dispatch({ type: 'marker.remove', markerId: id }, { label: 'Remove marker' })
}

let nudgeEnd = 0

/** Arrow-key nudges: a run of them, until a pause, is one undo step. */
export function nudgeMarker(id: string, delta: number): void {
  const marker = editor.getProject().markers.find((m) => m.id === id)
  if (!marker) return
  moveMarker(id, marker.time + delta, true)
  window.clearTimeout(nudgeEnd)
  nudgeEnd = window.setTimeout(() => editor.endGesture(), NUDGE_PAUSE_MS)
}

/** Where a dragged marker lands: on the playhead when snapping is on and it is within a few pixels. */
export function snapMarkerTime(time: number): number {
  const { snap, playhead, pxPerSec } = get()
  return snap && Math.abs(time - playhead) * pxPerSec < SNAP_PX ? playhead : time
}
