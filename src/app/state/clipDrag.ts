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

/** The empty stretch of a track around `time`, or null when a clip is there. */
export function gapAt(
  project: Project,
  trackId: string,
  time: number,
): { start: number; end: number } | null {
  let start = 0
  let end = Infinity
  for (const clip of clipsOnTrack(project, trackId)) {
    const clipEnd = clip.start + clip.duration
    if (clip.start <= time && time < clipEnd) return null
    if (clipEnd <= time) start = Math.max(start, clipEnd)
    else end = Math.min(end, clip.start)
  }
  return { start, end }
}

/** The track lyric lines go on: the template's Lyrics track, or a track named Lyrics. */
export function isLyricsTrack(p: Project, t: Track): boolean {
  return t.kind === 'visual' && (templateState(p)?.tracks.lyrics === t.id || t.name === 'Lyrics')
}

const isLyricClip = (c: Clip) => c.type === 'text' && !!c.lyricLineId

/** What a track takes, when it refuses a clip for its kind; `non-looks` is any track but a look lane, refusing a look. */
export type TrackTakes = 'audio' | 'visual' | 'lyrics' | 'looks' | 'non-looks'

export type DropRefusal =
  /** `length`: dropped on a clip it can't swap with, one of another length that isn't its neighbor. */
  | { reason: 'room'; length?: boolean }
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
  if (r.reason === 'room' && r.length)
    return 'No room there. A clip swaps places only with its neighbor or a clip of the same length.'
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

/** A clip staying on a track, by id, for an insert drag that may push it. */
export interface StayingSpan extends Span {
  id: string
}

/** A dragged clip of an insert drag, with the clips that stay on the track it drops on. */
export interface InsertSpan extends Span {
  others: readonly StayingSpan[]
}

/**
 * An insert drag: the moving clips go in at `shift`, and every clip staying on their tracks at or after the insert
 * point (where the group starts) moves right by the group's length. A drop inside a clip on the first span's track (the
 * grabbed clip's) goes in before or after that clip, whichever edge is nearer, rather than splitting it. Null when a
 * clip on another of the tracks still straddles the insert point.
 */
export function insertPlan(
  moving: readonly InsertSpan[],
  shift: number,
  lo: number,
): { shift: number; at: number; pushes: { id: string; start: number }[] } | null {
  const first = Math.min(...moving.map((c) => c.start))
  const length = Math.max(...moving.map((c) => c.end)) - first
  let at = first + Math.max(lo, shift)
  const straddles = (o: Span) => o.start < at - EPS && o.end > at + EPS
  const inside = moving[0]?.others.find(straddles)
  if (inside) at = at - inside.start <= inside.end - at ? inside.start : inside.end
  const pushes = new Map<string, number>()
  for (const c of moving)
    for (const o of c.others) {
      if (straddles(o)) return null
      if (o.start >= at - EPS) pushes.set(o.id, o.start + length)
    }
  return { shift: at - first, at, pushes: [...pushes].map(([id, start]) => ({ id, start })) }
}

/**
 * The clips staying on a track once `leaving` clips are gone from it, closed up: each moves left by the length of the
 * leaving clips that ended before it starts. Gaps that were there already stay. A ripple delete and a rearranging
 * insert close up a track this way.
 */
export function closeUp<T extends StayingSpan>(staying: readonly T[], leaving: readonly Span[]): T[] {
  return staying.map((o) => {
    const by = leaving.reduce((sum, l) => (l.end <= o.start + EPS ? sum + l.end - l.start : sum), 0)
    return by > 0 ? { ...o, start: o.start - by, end: o.end - by } : o
  })
}

/** A clip of a rearranging insert drag: where it was, the track it leaves and the track it goes to. */
export interface RearrangeSpan extends Span {
  from: string
  to: string
}

/**
 * A rearranging insert drag: the moving clips go in at `shift` as insertPlan puts them. A clip moved along its own track
 * leaves no gap there: the track closes up behind it (closeUp) before it goes in, and keeps its length. A clip moved to
 * another track leaves the one it was on as it was, so clips the person is not looking at don't move; Close gap closes
 * the gap it leaves. `staying` gives the clips that stay on a track, where they were before the drag; `moves` are those
 * that end up somewhere else. Null as for insertPlan.
 */
export function rearrangePlan(
  moving: readonly RearrangeSpan[],
  staying: (trackId: string) => readonly StayingSpan[],
  shift: number,
  lo: number,
): { shift: number; at: number; moves: { id: string; start: number }[] } | null {
  const closed = new Map<string, StayingSpan[]>()
  const closedOn = (trackId: string): StayingSpan[] => {
    let spans = closed.get(trackId)
    if (!spans) {
      spans = closeUp(
        staying(trackId),
        moving.filter((c) => c.from === trackId && c.to === trackId),
      )
      closed.set(trackId, spans)
    }
    return spans
  }
  const plan = insertPlan(
    moving.map((c) => ({ start: c.start, end: c.end, others: closedOn(c.to) })),
    shift,
    lo,
  )
  if (!plan) return null
  const pushed = new Map(plan.pushes.map((m) => [m.id, m.start]))
  const moves: { id: string; start: number }[] = []
  for (const trackId of new Set(moving.flatMap((c) => [c.from, c.to]))) {
    const was = new Map(staying(trackId).map((o) => [o.id, o.start]))
    for (const o of closedOn(trackId)) {
      const start = pushed.get(o.id) ?? o.start
      if (Math.abs(start - (was.get(o.id) ?? start)) > EPS) moves.push({ id: o.id, start })
    }
  }
  return { shift: plan.shift, at: plan.at, moves }
}

/**
 * How much longer than a gap a clip can be and still fill it, trimmed to fit, and how much two clips' lengths can
 * differ and still count as the same: a few frames, as between shots cut to a beat grid or split by eye.
 */
export const FIT_SLACK = 0.1

/**
 * A single clip dropped with the pointer over an empty stretch of the track (at `at` seconds): it goes in that stretch,
 * as near to `shift` as the stretch allows. A clip longer than the stretch by up to FIT_SLACK fills it, trimmed to
 * `duration`. Null when a clip is under the pointer or the clip is too long for the stretch. Shifts stay within
 * `lo`..`hi`.
 */
export function gapFit(
  c: MovingSpan,
  at: number,
  shift: number,
  lo: number,
  hi: number,
): { shift: number; duration?: number } | null {
  let start = c.start + lo
  let end = c.end + hi
  for (const o of c.others) {
    if (o.start <= at && at < o.end) return null
    if (o.end <= at) start = Math.max(start, o.end)
    else end = Math.min(end, o.start)
  }
  const length = c.end - c.start
  const room = end - start
  if (length <= room + EPS)
    return { shift: Math.max(start, Math.min(end - length, c.start + shift)) - c.start }
  return length - room <= FIT_SLACK ? { shift: start - c.start, duration: room } : null
}

/** Where a swap puts the dragged clip and the clip it was dropped on (`id`). */
export interface SwapPlan {
  id: string
  clip: Span
  other: Span
}

/**
 * A single clip dropped with the pointer on another clip (at `at` seconds), among `others` on the track it would go on.
 * Clips of the same length (within FIT_SLACK) swap places: each takes the other's start and length, so the cuts stay
 * where they were. Neighbors on one track (`sameTrack`) swap whatever their lengths: the first starts where the other
 * did, the second ends where the other did. 'length' for a clip it can't swap with; null when no clip is there.
 */
export function swapPlan(
  c: Span,
  at: number,
  others: readonly StayingSpan[],
  sameTrack: boolean,
): SwapPlan | 'length' | null {
  const o = others.find((o) => o.start <= at && at < o.end)
  if (!o) return null
  const length = c.end - c.start
  const otherLength = o.end - o.start
  if (Math.abs(length - otherLength) <= FIT_SLACK)
    return { id: o.id, clip: { start: o.start, end: o.end }, other: { start: c.start, end: c.end } }
  if (!sameTrack) return 'length'
  const after = o.start >= c.end - EPS
  const [lo, hi] = after ? [c.end, o.start] : [o.end, c.start]
  if (others.some((x) => x !== o && x.start >= lo - EPS && x.end <= hi + EPS)) return 'length'
  return after
    ? {
        id: o.id,
        clip: { start: o.end - length, end: o.end },
        other: { start: c.start, end: c.start + otherLength },
      }
    : {
        id: o.id,
        clip: { start: o.start, end: o.start + length },
        other: { start: c.end - otherLength, end: c.end },
      }
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
