/** Track order: dragging a track header, and Move up / Move down in its menu. */
import type { Project } from '../../model/index.ts'
import { dispatch, editor } from './project.ts'

/**
 * The positions a track can move to: among the tracks of its own kind, so visual tracks stay above the audio tracks.
 * Higher tracks draw over lower ones.
 */
export function trackMoveRange(p: Project, trackId: string): { min: number; max: number } {
  const kind = p.tracks.find((t) => t.id === trackId)?.kind
  const same = p.tracks.flatMap((t, i) => (t.kind === kind ? [i] : []))
  return { min: same[0] ?? 0, max: same[same.length - 1] ?? 0 }
}

/** Moves a track to `toIndex` (clamped to its range) as one undo step; false when it stays where it is. */
export function moveTrack(trackId: string, toIndex: number): boolean {
  const p = editor.getProject()
  const from = p.tracks.findIndex((t) => t.id === trackId)
  const { min, max } = trackMoveRange(p, trackId)
  const to = Math.min(max, Math.max(min, toIndex))
  if (from < 0 || to === from) return false
  return dispatch({ type: 'track.move', trackId, toIndex: to }, { label: 'Move track' })
}

/** Moves a track one place up (-1) or down (1). */
export function moveTrackBy(trackId: string, step: -1 | 1): boolean {
  const from = editor.getProject().tracks.findIndex((t) => t.id === trackId)
  return from >= 0 && moveTrack(trackId, from + step)
}
