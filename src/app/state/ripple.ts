/**
 * Ripple edits: removing clips or an empty stretch of a track and moving the track's later clips left to close the
 * gap (the clip menu, the lane menu, the palette and Shift Delete). Only the track the gap is on moves; lyric lines
 * stay with the vocals, so the Lyrics track never closes up.
 */
import { clipsOnTrack, type Clip, type Project } from '../../model/index.ts'
import { withCutouts } from './behind.ts'
import { closeUp, gapAt, isLyricsTrack } from './clipDrag.ts'
import { undoAction } from './library.ts'
import { dispatch, editor } from './project.ts'
import { selectedClipIds, toast, type Selection } from './ui.ts'

/** Gaps shorter than this (rounding) do not count. */
const EPS = 1e-3

export interface Gap {
  trackId: string
  start: number
  end: number
}

/** "3.6 s", for a gap's length. */
export const gapLength = (gap: Gap) => `${(gap.end - gap.start).toFixed(1)} s`

function closes(p: Project, trackId: string): boolean {
  const track = p.tracks.find((t) => t.id === trackId)
  return !!track && !isLyricsTrack(p, track)
}

/**
 * Where the clips that stay on the tracks of `removed` move when those tracks close up behind them: each later clip
 * moves left by the length of the removed clips before it.
 */
export function closeUpMoves(p: Project, removed: readonly Clip[]): { clipId: string; start: number }[] {
  const ids = new Set(removed.map((c) => c.id))
  const moves: { clipId: string; start: number }[] = []
  for (const trackId of new Set(removed.map((c) => c.trackId))) {
    if (!closes(p, trackId)) continue
    const leaving = removed
      .filter((c) => c.trackId === trackId)
      .map((c) => ({ start: c.start, end: c.start + c.duration }))
    const staying = clipsOnTrack(p, trackId)
      .filter((c) => !ids.has(c.id))
      .map((c) => ({ id: c.id, start: c.start, end: c.start + c.duration }))
    for (const o of closeUp(staying, leaving))
      if (o.start < (p.clips[o.id]?.start ?? o.start) - EPS) moves.push({ clipId: o.id, start: o.start })
  }
  return moves
}

/** The empty stretch of a track at `time` with a clip after it, so closing it moves something; not on the Lyrics track. */
export function gapToClose(p: Project, trackId: string, time: number): Gap | null {
  if (!closes(p, trackId)) return null
  const gap = gapAt(p, trackId, time)
  return gap && Number.isFinite(gap.end) && gap.end - gap.start > EPS ? { trackId, ...gap } : null
}

/** The empty stretch just before a clip on its track, back to the clip before it or the start. */
export function gapBefore(p: Project, clipId: string): Gap | null {
  const clip = p.clips[clipId]
  if (!clip || clip.start <= EPS) return null
  return gapToClose(p, clip.trackId, clip.start - EPS / 2)
}

/**
 * The gap the palette's Close gap closes: the one before the selected clip, else the one at the playhead on the
 * selected clip's track, else on the first track with one there.
 */
export function gapForPalette(p: Project, selection: Selection, playhead: number): Gap | null {
  const unlocked = (trackId: string) => !p.tracks.find((t) => t.id === trackId)?.locked
  const selected = selectedClipIds(selection)
    .map((id) => p.clips[id])
    .filter((c): c is Clip => !!c && unlocked(c.trackId))
  for (const clip of selected) {
    const gap = gapBefore(p, clip.id)
    if (gap) return gap
  }
  const tracks = [...new Set([...selected.map((c) => c.trackId), ...p.tracks.map((t) => t.id)])]
  for (const trackId of tracks.filter(unlocked)) {
    const gap = gapToClose(p, trackId, playhead)
    if (gap) return gap
  }
  return null
}

/** Removes an empty stretch of a track: its later clips move left by its length, as one undo step. */
export function closeGap(gap: Gap): boolean {
  const p = editor.getProject()
  const length = gap.end - gap.start
  const moves = clipsOnTrack(p, gap.trackId)
    .filter((c) => c.start >= gap.end - EPS)
    .map((c) => ({ clipId: c.id, start: c.start - length }))
  if (!moves.length) return false
  const label = 'Close gap'
  if (!dispatch({ type: 'clip.move', moves: withCutouts(p, moves) }, { label })) return false
  const track = p.tracks.find((t) => t.id === gap.trackId)
  toast(`Closed the ${gapLength(gap)} gap on ${track?.name ?? 'the track'}`, undoAction(label))
  return true
}
