import {
  createVideoClip,
  type EditCommand,
  type Id,
  type Project,
  type VideoClip,
} from '../../model/index.ts'
import { audibleClips } from '../../engine/audio.ts'
import { dispatch, editor, hasShotSound, playsOwnSound } from './project.ts'
import { get, selectedClipIds } from './ui.ts'

/**
 * A new shot of a video file, muted. Shots start silent however they are added, as drafts, auto-cut and VJ recordings
 * make them, so the song carries the sound; Inspector › Sound turns a shot's own sound on.
 */
export function createShot(o: Parameters<typeof createVideoClip>[0]): VideoClip {
  return { ...createVideoClip(o), muted: true }
}

/** The clips among `ids` whose own sound can be turned on and off (hasShotSound). */
export function soundShots(project: Project, ids: readonly Id[]): VideoClip[] {
  return ids.flatMap((id) => {
    const clip = project.clips[id]
    return hasShotSound(project, clip) ? [clip] : []
  })
}

/** The selected shots whose own sound can be turned on and off, for the palette. */
export function selectedShots(): VideoClip[] {
  return soundShots(editor.getProject(), selectedClipIds(get().selection))
}

/** Why a shot set to play its sound isn't heard, in the preview and the export, or null when it is. */
export function shotSilencedBy(project: Project, clip: VideoClip): string | null {
  if (!playsOwnSound(project, clip) || audibleClips(project).some((c) => c.clipId === clip.id)) return null
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (track?.hidden) return 'Its track is hidden, so it’s silent.'
  if (track?.muted) return 'Its track is muted, so it’s silent.'
  if (!clip.enabled) return null
  return 'A soloed track or stem silences it.'
}

/** Mutes or unmutes the shots' own sound, as one undo step. */
export function setShotsMuted(ids: readonly Id[], muted: boolean): boolean {
  const shots = soundShots(editor.getProject(), ids).filter((c) => c.muted !== muted)
  if (!shots.length) return false
  return dispatch(
    shots.map((c): EditCommand => ({ type: 'clip.set', clipId: c.id, path: ['muted'], value: muted })),
    { label: muted ? 'Mute shot sound' : 'Unmute shot sound' },
  )
}

/**
 * Sets the shots' volume (0..1) as one undo step, unmuting them unless `keepMuted`: picking a level means hearing it.
 * Like Opacity for several clips, it sets the value under any keyframes. Pass `coalesceKey` for a slider drag.
 */
export function setShotsVolume(
  ids: readonly Id[],
  volume: number,
  { coalesceKey, keepMuted = false }: { coalesceKey?: string; keepMuted?: boolean } = {},
): boolean {
  const shots = soundShots(editor.getProject(), ids)
  if (!shots.length) return false
  const value = Math.min(1, Math.max(0, volume))
  const commands = shots.flatMap((c): EditCommand[] => [
    ...(c.volume.value === value
      ? []
      : [{ type: 'clip.set' as const, clipId: c.id, path: ['volume', 'value'], value }]),
    ...(c.muted && !keepMuted
      ? [{ type: 'clip.set' as const, clipId: c.id, path: ['muted'], value: false }]
      : []),
  ])
  if (!commands.length) return false
  return dispatch(commands, { label: 'Change shot volume', ...(coalesceKey ? { coalesceKey } : {}) })
}
