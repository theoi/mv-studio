/** Read-only helpers over a project. */
import type { Clip, Id, Project, Seconds, Track } from './types.ts'

/**
 * Whether the song's bars were found: at least two bar starts, since one alone gives no bar length. Until then,
 * anything that cuts, snaps, counts or pulses on bars falls back to beats.
 */
export function hasFoundBars(grid: { readonly downbeats?: readonly Seconds[] } | undefined): boolean {
  return (grid?.downbeats?.length ?? 0) >= 2
}

/** What the app says about a song's bars while it cannot count them, worded the same wherever it is shown. */
export const BARS_NOTES = {
  /** While the bars are being looked for: a job stage, a badge or the position readout. */
  finding: 'Finding bars…',
  /** After a search that did not find them. */
  notFound: 'Bars not found yet',
  /** The playhead is before the song's first bar. */
  beforeFirstBar: 'Before the first bar',
  /** How to look for them again, outside the Song analysis panel. */
  analyzeAgain: 'Analyze again in Assist › Song analysis to look for them.',
  /** A cut plan made without them. */
  beatsOnly:
    'Bars not found yet, so the cuts follow the beats. Analyze again in Assist › Song analysis to look for them.',
  /** What an effect pulsing on bars follows instead. */
  everyFourthBeat: 'every fourth beat (bars not found yet)',
} as const

/** Project length: explicit duration, else the end of the last clip, else 0. */
export function projectDuration(project: Project): Seconds {
  if (project.duration !== undefined) return project.duration
  let end = 0
  for (const clip of Object.values(project.clips)) end = Math.max(end, clip.start + clip.duration)
  return end
}

/**
 * How far before the project's end its last frame is. Every clip has ended at the end itself, so the frame there is
 * empty: the preview draws a playhead at the end this much earlier, and the app's End goes to the same place.
 */
export const LAST_FRAME_LEAD: Seconds = 0.01

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
