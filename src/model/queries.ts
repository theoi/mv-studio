/** Read-only helpers over a project. */
import type { Clip, Id, Project, Seconds, Track } from './types.ts'

/** Project length: explicit duration, else the end of the last clip, else 0. */
export function projectDuration(project: Project): Seconds {
  if (project.duration !== undefined) return project.duration
  let end = 0
  for (const clip of Object.values(project.clips)) end = Math.max(end, clip.start + clip.duration)
  return end
}

export function clipsOnTrack(project: Project, trackId: Id): Clip[] {
  return Object.values(project.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
}

export function clipsAt(project: Project, time: Seconds): Clip[] {
  return Object.values(project.clips).filter(
    (c) => c.enabled && time >= c.start && time < c.start + c.duration,
  )
}

/** Tracks whose clips are audible/visible, honoring mute, solo and hidden. */
export function activeTracks(project: Project): Track[] {
  const soloed = project.tracks.some((t) => t.solo)
  return project.tracks.filter((t) => !t.hidden && (soloed ? t.solo : !t.muted))
}
