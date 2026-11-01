import {
  createVideoClip,
  type EditCommand,
  type Id,
  type Project,
  type Seconds,
  type VideoClip,
} from '../../model/index.ts'
import { evaluate } from '../../engine/animation.ts'
import { audibleClips } from '../../engine/audio.ts'
import { formatTime } from '../format.ts'
import { keyframeAt, valueAtCommands } from './keyframes.ts'
import { dispatch, editor, hasShotSound, playsOwnSound } from './project.ts'
import { get, selectedClipIds, toast, type Toast } from './ui.ts'

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

/**
 * The toast for shots just added by hand: `message`, plus a sentence saying the sound is off for those whose files
 * have sound (they start muted), with a fix that turns it on as one undo step. Stills and silent files add nothing.
 */
export function addedToast(message: string, ids: readonly Id[]): { message: string; fix?: Toast['fix'] } {
  const off = soundShots(editor.getProject(), ids).filter((c) => c.muted)
  if (!off.length) return { message }
  const note =
    ids.length === 1
      ? 'Its sound is off.'
      : off.length === ids.length
        ? 'Their sound is off.'
        : `Sound is off for ${off.length} of them.`
  const offIds = off.map((c) => c.id)
  return {
    message: `${message}. ${note}`,
    fix: {
      label: 'Turn sound on',
      run: () => void setShotsMuted(offIds, false),
      done: () => soundShots(editor.getProject(), offIds).every((c) => !c.muted),
    },
  }
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
 * Whether a level set at timeline time `at` reaches the shot: it has no Volume keyframes, or `at` is within it, where
 * the level becomes the keyframe at `at`.
 */
export function volumeSettableAt(clip: VideoClip, at: Seconds): boolean {
  return !clip.volume.keyframes?.length || (at >= clip.start && at <= clip.start + clip.duration)
}

/** The shot's volume at timeline time `at`, following its keyframes, as its Inspector slider shows it. */
export const shotVolumeAt = (clip: VideoClip, at: Seconds): number =>
  evaluate(clip.volume, Math.max(0, at - clip.start))

/** Says which of the shots a level set at `at` leaves alone (volumeSettableAt), or null when it reaches them all. */
export function volumeKeptNote(shots: readonly VideoClip[], at: Seconds): string | null {
  const n = shots.filter((c) => !volumeSettableAt(c, at)).length
  if (!n) return null
  return n === 1
    ? '1 shot has Volume keyframes away from the playhead, so its volume stays. Move the playhead over it to set a keyframe there.'
    : `${n} shots have Volume keyframes away from the playhead, so their volume stays. Move the playhead over one to set a keyframe there.`
}

/**
 * Sets the shots' volume (0..1) as one undo step, unmuting them unless `keepMuted`: picking a level means hearing it.
 * A shot with Volume keyframes gets the level as the keyframe at timeline time `at` (the playhead), as its Inspector
 * slider sets it, and is left alone when `at` is outside it (volumeKeptNote). Pass `coalesceKey` for a slider drag.
 */
export function setShotsVolume(
  ids: readonly Id[],
  volume: number,
  {
    at = get().playhead,
    coalesceKey,
    keepMuted = false,
  }: { at?: Seconds; coalesceKey?: string; keepMuted?: boolean } = {},
): boolean {
  const shots = soundShots(editor.getProject(), ids).filter((c) => volumeSettableAt(c, at))
  if (!shots.length) return false
  const value = Math.min(1, Math.max(0, volume))
  const changed = shots.filter((c) => shotVolumeAt(c, at) !== value)
  const commands = [
    ...changed.flatMap((c) => valueAtCommands(c, ['volume'], value, at - c.start)),
    ...shots.flatMap((c): EditCommand[] =>
      c.muted && !keepMuted ? [{ type: 'clip.set', clipId: c.id, path: ['muted'], value: false }] : [],
    ),
  ]
  if (!commands.length) return false
  const added = changed.filter((c) => c.volume.keyframes?.length && !keyframeAt(c.volume, at - c.start))
  if (!dispatch(commands, { label: 'Change shot volume', ...(coalesceKey ? { coalesceKey } : {}) }))
    return false
  if (added.length)
    toast(
      added.length > 1
        ? `${added.length} keyframes added at ${formatTime(at, true)}`
        : `Keyframe added at ${formatTime(at, true)}`,
    )
  return true
}
