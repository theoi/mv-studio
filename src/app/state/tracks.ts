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
  if (!dispatch({ type: 'track.move', trackId, toIndex: to }, { label: 'Move track' })) return false
  const note = coveringNote(p, editor.getProject(), trackId)
  if (note) toast(note, { label: 'Undo', run: undo })
  return true
}

/** Moves a track one place up (-1) or down (1). */
export function moveTrackBy(trackId: string, step: -1 | 1): boolean {
  const from = editor.getProject().tracks.findIndex((t) => t.id === trackId)
  return from >= 0 && moveTrack(trackId, from + step)
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
    const by = over.name === 'Video' ? 'the video' : over.name
    return role(before, under) === 'lyrics'
      ? `The lyrics are behind ${by} now, so it covers them.`
      : `This text is behind ${by} now, so it covers it.`
  }
  return covered(['look']) ? 'The look no longer colors the tracks above it.' : null
}
