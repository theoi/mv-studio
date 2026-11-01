/** Track order: dragging a track header, and Move up / Move down in its menu. */
import { clipsOnTrack, type Project, type Track } from '../../model/index.ts'
import { dispatch, editor, isLookClip, undo } from './project.ts'
import { toast } from './ui.ts'

/**
 * The positions a track can move to: among the tracks of its own kind, so visual tracks stay above the audio tracks.
 * Higher tracks draw over lower ones.
 */
export function trackMoveRange(p: Project, trackId: string): { min: number; max: number } {
  const kind = p.tracks.find((t) => t.id === trackId)?.kind
  const same = p.tracks.flatMap((t, i) => (t.kind === kind ? [i] : []))
  return { min: same[0] ?? 0, max: same[same.length - 1] ?? 0 }
}

/**
 * Moves a track to `toIndex` (clamped to its range) as one undo step; false when it stays where it is. When the move
 * changes what covers what, a toast says so, with Undo.
 */
export function moveTrack(trackId: string, toIndex: number): boolean {
  const p = editor.getProject()
  const from = p.tracks.findIndex((t) => t.id === trackId)
  const { min, max } = trackMoveRange(p, trackId)
  const to = Math.min(max, Math.max(min, toIndex))
  if (from < 0 || to === from) return false
  const label = `Move ${p.tracks[from]!.name} ${to < from ? 'up' : 'down'}`
  if (!dispatch({ type: 'track.move', trackId, toIndex: to }, { label })) return false
  const after = editor.getProject()
  const note = coveringNote(p, after, trackId)
  if (note)
    toast(note, {
      label: 'Undo',
      run: () => {
        // Every move of this track this way has this label, so the track order tells whether the last one is still
        // this move.
        if (editor.undoLabel() === label && sameOrder(editor.getProject().tracks, after.tracks)) undo()
      },
    })
  return true
}

const sameOrder = (a: Track[], b: Track[]) => a.length === b.length && a.every((t, i) => t.id === b[i]?.id)

/** What turning a track setting on and off is called. */
export const TRACK_TOGGLES = {
  muted: ['Mute', 'Unmute'],
  solo: ['Solo', 'Unsolo'],
  locked: ['Lock', 'Unlock'],
  hidden: ['Hide', 'Show'],
} as const

export type TrackToggle = keyof typeof TRACK_TOGGLES

/** Turns a track setting on or off as one undo step, named for the action and the track: "Undid: Hide Video". */
export function toggleTrack(trackId: string, key: TrackToggle): void {
  const track = editor.getProject().tracks.find((t) => t.id === trackId)
  if (!track) return
  dispatch(
    { type: 'track.update', trackId, patch: { [key]: !track[key] } },
    { label: `${TRACK_TOGGLES[key][track[key] ? 1 : 0]} ${track.name}` },
  )
}

/** Moves a track one place up (-1) or down (1). */
export function moveTrackBy(trackId: string, step: -1 | 1): boolean {
  const from = editor.getProject().tracks.findIndex((t) => t.id === trackId)
  return from >= 0 && moveTrack(trackId, from + step)
}

/** What a screen reader hears after Move up or Move down: the track's place among the tracks of its kind. */
export function moveAnnouncement(p: Project, trackId: string, step: -1 | 1, moved: boolean): string {
  const track = p.tracks.find((t) => t.id === trackId)
  const way = step < 0 ? 'up' : 'down'
  if (!track) return ''
  if (!moved) return `The ${track.name} track can't move further ${way}.`
  const { min, max } = trackMoveRange(p, trackId)
  const place = p.tracks.indexOf(track) - min + 1
  return `Moved the ${track.name} track ${way}, to ${place} of ${max - min + 1}.`
}

type Role = 'lyrics' | 'text' | 'look' | 'covers'

/** What a visual track's clips do to the tracks under it; null for audio and empty tracks. */
function role(p: Project, t: Track): Role | null {
  if (t.kind !== 'visual') return null
  const clips = clipsOnTrack(p, t.id)
  if (!clips.length) return null
  if (clips.every((c) => c.type === 'text' && c.lyricLineId)) return 'lyrics'
  if (clips.every((c) => c.type === 'text')) return 'text'
  if (clips.every(isLookClip)) return 'look'
  return 'covers'
}

/**
 * The note after a move of `trackId` from `before` to `after` that changes what covers what: lyrics or text that went
 * behind a track with clips, which now covers them, or the look moved below one, which it no longer colors. Null when
 * nothing changed that way, or the moved track is empty. Moving the look above a track it did not color says nothing.
 */
export function coveringNote(before: Project, after: Project, trackId: string): string | null {
  const moved = before.tracks.find((t) => t.id === trackId)
  if (!moved || !role(before, moved)) return null
  const at = (p: Project, id: string) => p.tracks.findIndex((t) => t.id === id)
  // Pairs of the moved track and another whose order flipped: [the one now underneath, the one now over it].
  const flipped = before.tracks.flatMap((other) => {
    if (other.id === trackId) return []
    const wasAbove = at(before, trackId) < at(before, other.id)
    const isAbove = at(after, trackId) < at(after, other.id)
    if (wasAbove === isAbove) return []
    return [isAbove ? ([other, moved] as const) : ([moved, other] as const)]
  })
  const covered = (kinds: Role[]) =>
    flipped
      .filter(([under, over]) => kinds.includes(role(before, under)!) && role(before, over) === 'covers')
      // The track right over the covered one names what covers it.
      .sort(([, a], [, b]) => at(after, b.id) - at(after, a.id))[0]
  const text = covered(['lyrics', 'text'])
  if (text) {
    const [under, over] = text
    const by = over.name === 'Video' ? 'the video' : `the ${over.name} track`
    if (role(before, under) === 'lyrics') return `The lyrics are behind ${by} now, which covers them.`
    return clipsOnTrack(before, under.id).length > 1
      ? `These text clips are behind ${by} now, which covers them.`
      : `This text is behind ${by} now, which covers it.`
  }
  return covered(['look']) ? 'The look no longer colors the tracks above it.' : null
}
