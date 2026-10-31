/**
 * Where a clip dragged on the timeline can drop. A clip moves along its track or to another unlocked track that takes
 * its kind. It lands where the pointer puts it when that stretch is free, butts up against a neighbor it overlaps by a
 * few pixels, and otherwise has no room: the drop snaps back and says why.
 */
import { clipsOnTrack, type Clip, type Project, type Track } from '../../model/index.ts'
import { templateState } from '../../plugins/templates.ts'
import { isLookClip, viewOf, type ClipKindView } from './project.ts'

/** Overlaps shorter than this (rounding) do not count. */
const EPS = 1e-3

/** How close, in pixels, a drop that overlaps a neighbor must be to butt up against it instead. */
export const BUTT_PX = 8

/** The track lyric lines go on: the template's Lyrics track, or a track named Lyrics. */
export function isLyricsTrack(p: Project, t: Track): boolean {
  return t.kind === 'visual' && (templateState(p)?.tracks.lyrics === t.id || t.name === 'Lyrics')
}

const isLyricClip = (c: Clip) => c.type === 'text' && !!c.lyricLineId

/** What a track takes, when it refuses a clip for its kind; `non-looks` is any track but a look lane, refusing a look. */
export type TrackTakes = 'audio' | 'visual' | 'lyrics' | 'looks' | 'non-looks'

export type DropRefusal =
  | { reason: 'room' }
  | { reason: 'locked'; track: Track }
  | { reason: 'kind'; clip: Clip; track: Track; takes: TrackTakes }

/**
 * Why a clip can't move to a track, or null when it can. As paste does: a locked track takes nothing, a look goes only
 * on a look lane (a track holding only looks; not an empty track, where it would stop grading the picture below it),
 * audio and visual tracks take only their own kind, the Lyrics track takes only lyric lines, and a look lane takes only
 * looks. `moving` are the clips dragged with it, which don't count as staying on the track.
 */
export function refuseTrack(
  p: Project,
  clip: Clip,
  track: Track,
  moving: ReadonlySet<string> = new Set(),
): DropRefusal | null {
  if (track.locked) return { reason: 'locked', track }
  if (clip.trackId === track.id) return null
  const refuse = (takes: TrackTakes): DropRefusal => ({ reason: 'kind', clip, track, takes })
  const staying = clipsOnTrack(p, track.id).filter((c) => !moving.has(c.id))
  const lookLane = track.kind === 'visual' && staying.length > 0 && staying.every(isLookClip)
  if (isLookClip(clip)) return lookLane ? null : refuse('non-looks')
  if (track.kind === 'audio') return clip.type === 'audio' ? null : refuse('audio')
  if (clip.type === 'audio') return refuse('visual')
  if (isLyricsTrack(p, track) || (staying.length > 0 && staying.every(isLyricClip)))
    return isLyricClip(clip) ? null : refuse('lyrics')
  return lookLane ? refuse('looks') : null
}

const kindNames: Record<ClipKindView, string> = {
  video: 'Video',
  image: 'Image',
  text: 'Text',
  lyric: 'Lyric',
  visualizer: 'Visual',
  audio: 'Audio',
  look: 'Look',
  other: 'Adjustment',
}

function kindName(p: Project, clip: Clip): string {
  return clip.type === 'solid' ? 'Color' : kindNames[viewOf(p, clip).kind]
}

const takesLabels: Record<TrackTakes, string> = {
  audio: 'Audio only',
  visual: 'Visual clips only',
  lyrics: 'Lyric lines only',
  looks: 'Looks only',
  'non-looks': 'No looks here',
}

/** The label in the drop preview: for a kind, what the track takes. */
export function refusalLabel(r: DropRefusal): string {
  return r.reason === 'room' ? 'No room' : r.reason === 'locked' ? 'Track is locked' : takesLabels[r.takes]
}

/** The toast after a refused drop. */
export function refusalToast(p: Project, r: DropRefusal): string {
  if (r.reason === 'room') return 'No room there. Drop it on an empty stretch or another track.'
  if (r.reason === 'locked') return 'That track is locked. Unlock it to drop clips there.'
  return `${kindName(p, r.clip)} clips can't go on the ${r.track.name} track.`
}

export interface Span {
  start: number
  end: number
}

/** A dragged clip: where it was, and the clips that stay on the track it would drop on. */
export interface MovingSpan extends Span {
  others: readonly Span[]
}

/** The first of the moving clips that overlaps a clip staying on its track when they all shift by `shift`. */
export function blockedAt(moving: readonly MovingSpan[], shift: number): number {
  return moving.findIndex((c) =>
    c.others.some((o) => o.start < c.end + shift - EPS && o.end > c.start + shift + EPS),
  )
}

/**
 * The shift that drops every moving clip on free space, or null when there is none nearby. The snapped shift wins
 * when it fits, then the pointer's own (`raw`); otherwise the nearest shift within `tolerance` of raw that butts a
 * clip up against a neighbor, with `edge` the time where they meet. Shifts stay within `lo`..`hi`.
 */
export function dropShift(
  moving: readonly MovingSpan[],
  snapped: number,
  raw: number,
  tolerance: number,
  lo: number,
  hi: number,
): { shift: number; edge: number | null } | null {
  const clamp = (s: number) => Math.min(hi, Math.max(lo, s))
  const fits = (s: number) =>
    moving.every((c) => c.others.every((o) => o.start >= c.end + s - EPS || o.end <= c.start + s + EPS))
  for (const s of [clamp(snapped), clamp(raw)]) if (fits(s)) return { shift: s, edge: null }
  const at = clamp(raw)
  let best: { shift: number; edge: number } | null = null
  for (const c of moving)
    for (const o of c.others)
      for (const [shift, edge] of [
        [o.end - c.start, o.end],
        [o.start - c.end, o.start],
      ] as const) {
        const d = Math.abs(shift - at)
        if (d > tolerance || shift < lo - EPS || shift > hi + EPS) continue
        if (best && d >= Math.abs(best.shift - at)) continue
        if (fits(shift)) best = { shift, edge }
      }
  return best
}
