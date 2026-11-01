import {
  clipsOnTrack,
  type Asset,
  type Clip,
  type EditCommand,
  type Project,
  type Seconds,
} from '../../model/index.ts'
import { directorMeta } from '../../director/meta.ts'
import { autoCutMeta } from '../../vision/autocut/apply.ts'
import { formatTime, plural } from '../format.ts'
import { withCutouts } from './behind.ts'
import { gapAt, insertPlan } from './clipDrag.ts'
import { assetPlacement, baseName, importFiles, isLyricTrack, placementDuration } from './importer.ts'
import { undoAction, type LibraryDropHint } from './library.ts'
import { barsToSeconds } from './prefs.ts'
import { bpmOf, dispatch, editor, isLookClip } from './project.ts'
import { isReplaceable, replaceClipMedia } from './replace.ts'
import { addedToast } from './shotSound.ts'
import { barsState } from './songAnalysis.ts'
import { select, toast } from './ui.ts'

/*
 * Media dragged onto the timeline: Library › Media cards, and files from the computer. Either lands where it is
 * dropped, on that track when it fits there; a card dropped in a gap between clips fills it. A video or image card
 * dropped on a shot goes in at the cut nearer the pointer and pushes the later clips right, as does any video or image
 * card with Ctrl held. A card dropped on a video clip or image with Alt held replaces what the clip shows instead.
 */

/** Drag data type of Library › Media cards. */
export const MEDIA_DRAG_TYPE = 'application/x-mv-studio-media'

type Dragged = { dataTransfer: DataTransfer | null }

let dragging: string | null = null

export function startMediaDrag(e: Dragged, assetId: string): void {
  e.dataTransfer?.setData(MEDIA_DRAG_TYPE, assetId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  dragging = assetId
}

export function endMediaDrag(): void {
  dragging = null
}

/** A Library › Media card or files. Drop targets check while dragging, when the data itself is not readable. */
export function isMediaDrag(e: Dragged): boolean {
  const types = e.dataTransfer?.types ?? []
  return types.includes(MEDIA_DRAG_TYPE) || types.includes('Files')
}

/**
 * Where dragged media would land, as a span on a track. `newTrack`: it needs a track of its own, so its span is shown
 * on the hovered one. `replace`: the span is the clip it replaces. `canReplace`: the pointer is on a clip that Alt would
 * replace instead. `insert`: it goes in at `at` and `moved` later clips on the track move right by its length; `bars`:
 * it is trimmed to that many bars so they stay on the beat; `pastSong`: the video then ends that long after the song.
 */
export type MediaDropSpan = {
  trackId: string
  start: Seconds
  end: Seconds
  newTrack?: true
  replace?: true
  trimmed?: true
  insert?: { at: Seconds; moved: number; bars?: number; pastSong?: Seconds }
  elsewhere?: { trackId: string; at: Seconds; name: string }
  canReplace?: { trackId: string; at: Seconds }
}

/** Where dragged media would land, or the locked or hidden track that refuses it (see MediaDropSpan). */
export type MediaDropHint =
  Extract<LibraryDropHint, { locked: true }> | { trackId: string; hidden: true; at: Seconds } | MediaDropSpan

/** Where the pointer is over a track while media is dragged: `time` snapped for placing, `pointer` as it is. */
export interface MediaDropPoint {
  trackId: string
  time: Seconds
  pointer: Seconds
  /** Alt is held: a card on a video clip or image replaces what it shows. */
  alt: boolean
  /** Ctrl (Cmd on a Mac) is held: a video or image card goes in by insert wherever it is dropped on the track. */
  mod?: boolean
}

/**
 * What a drag looks up again on every dragover, kept per project. A project is never changed in place, so each holds
 * until the next edit, and a drag over a long timeline doesn't walk every clip each time the pointer moves.
 */
interface Lookups {
  clips: Map<string, Clip[]>
  inserts: Map<string, boolean>
  bar?: Seconds | null
  ends?: { song?: Seconds; picture: Seconds }
}

const lookups = new WeakMap<Project, Lookups>()

function lookupsOf(project: Project): Lookups {
  let found = lookups.get(project)
  if (!found) lookups.set(project, (found = { clips: new Map(), inserts: new Map() }))
  return found
}

/** The clips on a track, in start order. */
function trackClips(project: Project, trackId: string): readonly Clip[] {
  const { clips } = lookupsOf(project)
  let found = clips.get(trackId)
  if (!found) clips.set(trackId, (found = clipsOnTrack(project, trackId)))
  return found
}

/** The video clip or image on a track at `time`. */
function shotAt(project: Project, trackId: string, time: Seconds): Clip | undefined {
  return trackClips(project, trackId).find(
    (c) => isReplaceable(c) && c.start <= time && time < c.start + c.duration,
  )
}

/** The clip a card being dragged replaces when dropped at `at` with Alt held, if it is a video or image. */
function replaced(project: Project, at: MediaDropPoint, asset: Asset | undefined) {
  if (asset?.kind !== 'video' && asset?.kind !== 'image') return undefined
  return shotAt(project, at.trackId, at.pointer)
}

/**
 * Whether footage can go in by insert on a track: a visual track that isn't locked, kept for lyric lines or a look
 * lane.
 */
function takesInserts(project: Project, trackId: string): boolean {
  const { inserts } = lookupsOf(project)
  let takes = inserts.get(trackId)
  if (takes === undefined) {
    const track = project.tracks.find((t) => t.id === trackId)
    takes =
      track?.kind === 'visual' &&
      !track.locked &&
      !isLyricTrack(project, trackId) &&
      !trackClips(project, trackId).some(isLookClip)
    inserts.set(trackId, takes)
  }
  return takes
}

/** How long one of the song's bars is, once they are found: the median time between downbeats. */
function barLength(project: Project): Seconds | null {
  const found = lookupsOf(project)
  if (found.bar === undefined) {
    const bars = barsState(project)
    const downbeats = bars.status === 'ready' ? bars.downbeats : []
    const gaps = downbeats
      .slice(1)
      .map((t, i) => t - (downbeats[i] as number))
      .filter((g) => g > 0)
      .sort((a, b) => a - b)
    found.bar = gaps[gaps.length >> 1] ?? null
  }
  return found.bar
}

/** Where the song ends on the timeline, if the project has one, and where the picture ends (its last visual clip). */
function endsOf(project: Project): { song?: Seconds; picture: Seconds } {
  const found = lookupsOf(project)
  if (!found.ends) {
    const id = project.songAssetId
    const songClip = id && Object.values(project.clips).find((c) => 'assetId' in c && c.assetId === id)
    const song = songClip ? songClip.start + songClip.duration : id ? project.assets[id]?.duration : undefined
    const visual = new Set(project.tracks.filter((t) => t.kind === 'visual').map((t) => t.id))
    let picture = 0
    for (const c of Object.values(project.clips))
      if (visual.has(c.trackId)) picture = Math.max(picture, c.start + c.duration)
    found.ends = { song, picture }
  }
  return found.ends
}

/** A shot cut to the music, by an auto-cut or a director draft. */
const isBeatCut = (c: Clip) => !!autoCutMeta(c) || directorMeta(c)?.role === 'shots'

/** A gap shorter than this isn't filled: the card goes where it would go anyway. */
const MIN_FILL = 0.5

/**
 * Where a card dropped at `at` lands. In an empty stretch of the track that ends at a clip, such as the gap a deleted
 * shot left, it stays on that track. A card that fits goes as near the drop point as the stretch allows. A longer one
 * is trimmed at the stretch's end: it fills the stretch from its start when dropped within a bar of it, else it starts
 * at the drop point, so a drop far into a long stretch stays where it was let go. Elsewhere the card goes as
 * assetPlacement puts it from the drop point: on that track when it is free there, else on the first free track of its
 * kind or a new one.
 */
function cardPlacement(project: Project, asset: Asset, at: MediaDropPoint) {
  const plain = assetPlacement(project, asset, { start: at.time, trackId: at.trackId })
  const gap = gapAt(project, at.trackId, at.pointer)
  if (!plain || !gap || !Number.isFinite(gap.end) || gap.end - gap.start < MIN_FILL)
    return plain && { ...plain, trimmed: false, fills: false }
  const length = plain.clip.duration
  const time = Math.min(Math.max(at.time, gap.start), gap.end)
  const start =
    length <= gap.end - gap.start
      ? Math.max(gap.start, Math.min(time, gap.end - length))
      : time - gap.start <= barsToSeconds(1, bpmOf(project))
        ? gap.start
        : Math.min(time, gap.end - MIN_FILL)
  const fit = assetPlacement(project, asset, { start, trackId: at.trackId, maxDuration: gap.end - start })
  return fit?.clip.trackId === at.trackId
    ? { ...fit, trimmed: fit.clip.duration < length - 1e-3, fills: start === gap.start }
    : { ...plain, trimmed: false, fills: false }
}

/**
 * Where an insert at `pointer` on a track goes in: the nearer edge of the clip under the pointer, else `time`. `cut`:
 * one clip ends there and another starts.
 */
export function insertSpot(
  project: Project,
  trackId: string,
  pointer: Seconds,
  time: Seconds = pointer,
): { at: Seconds; cut: boolean } {
  const clips = trackClips(project, trackId)
  const under = clips.find((c) => c.start <= pointer && pointer < c.start + c.duration)
  const end = under && under.start + under.duration
  const at = under && end !== undefined ? (pointer - under.start <= end - pointer ? under.start : end) : time
  const near = (t: number) => Math.abs(t - at) < 1e-3
  return { at, cut: clips.some((c) => near(c.start + c.duration)) && clips.some((c) => near(c.start)) }
}

/**
 * A video or image going in by insert on a track: at `start` for `duration`, the later clips on the track moving to
 * `pushes`. `bars`: trimmed to that many bars, so the later shots of a cut made to the music stay on the beat.
 * `pastSong`: how long after the song the video then ends, when the insert makes it run past the song.
 */
interface InsertPlan {
  trackId: string
  start: Seconds
  duration: Seconds
  pushes: { id: string; start: Seconds }[]
  bars?: number
  pastSong?: Seconds
}

/**
 * Plans an insert at `from` of footage `full` seconds long, as insertPlan moves the later clips for a clip dragged with
 * Ctrl. On a track of shots cut to the music, when the song's bars are found and later shots move, the footage is
 * trimmed to whole bars so they move by whole bars: as many as fit in a video, at least one for an image (which has no
 * end of its own, so a hair over its length still counts). Footage shorter than a bar keeps its length.
 */
function planInsert(project: Project, trackId: string, from: Seconds, full: Seconds, image: boolean) {
  const clips = trackClips(project, trackId)
  const others = clips.map((c) => ({ id: c.id, start: c.start, end: c.start + c.duration }))
  const fit = (length: number) => insertPlan([{ start: from, end: from + length, others }], 0, 0)
  let plan = fit(full)
  if (!plan) return null
  let duration = full
  let bars: number | undefined
  const bar = plan.pushes.length && clips.some(isBeatCut) ? barLength(project) : null
  if (bar) {
    const count = Math.max(image ? 1 : 0, Math.floor((full + (image ? 0.05 * bar : 1e-3)) / bar))
    if (count >= 1) {
      duration = image ? count * bar : Math.min(full, count * bar)
      if (duration < full - 0.05) bars = count
      plan = fit(duration) ?? plan
    }
  }
  const moved = new Set(plan.pushes.map((p) => p.id))
  let end = plan.at + duration
  for (const c of clips) if (moved.has(c.id)) end = Math.max(end, c.start + c.duration + duration)
  const { song, picture } = endsOf(project)
  const after = Math.max(picture, end)
  const pastSong =
    song !== undefined && after > song + 0.05 && after > picture + 1e-3 ? after - song : undefined
  const planned: InsertPlan = { trackId, start: plan.at, duration, pushes: plan.pushes }
  if (bars) planned.bars = bars
  if (pastSong !== undefined) planned.pastSong = pastSong
  return planned
}

let lastInsert: { project: Project; key: string; plan: InsertPlan | null } | null = null

/**
 * How a video or image card dropped at `at` goes in by insert: on a shot (a video clip or image) at the cut nearer the
 * pointer, and with Ctrl held at the drop point anywhere on the track. `hidden` on a hidden track, which takes no
 * insert: the shots it would push are out of sight. Null where the card goes as cardPlacement puts it: an audio card,
 * the drop off a shot without Ctrl, or a track that takes no footage (the lyrics track, a look lane, a locked track).
 * The plan is kept for the insert point, so the pointer moving along a drag doesn't plan it again.
 */
function insertFor(project: Project, asset: Asset, at: MediaDropPoint): InsertPlan | 'hidden' | null {
  if (asset.kind !== 'video' && asset.kind !== 'image') return null
  if (!takesInserts(project, at.trackId)) return null
  if (!at.mod && !shotAt(project, at.trackId, at.pointer)) return null
  if (project.tracks.find((t) => t.id === at.trackId)?.hidden) return 'hidden'
  const from = insertSpot(project, at.trackId, at.pointer, at.time).at
  const full = placementDuration(project, asset)
  const key = `${asset.id} ${at.trackId} ${from} ${full}`
  if (lastInsert?.project !== project || lastInsert.key !== key)
    lastInsert = { project, key, plan: planInsert(project, at.trackId, from, full, asset.kind === 'image') }
  return lastInsert.plan
}

/** The commands that make an insert: the later clips move right, their cutouts with them, and the card goes in. */
function insertCommands(project: Project, asset: Asset, plan: InsertPlan) {
  const placed = assetPlacement(project, asset, {
    start: plan.start,
    duration: plan.duration,
    trackId: plan.trackId,
    onTrack: true,
  })
  if (placed?.clip.trackId !== plan.trackId) return null
  const moves = withCutouts(
    project,
    plan.pushes.map((m) => ({ clipId: m.id, start: m.start })),
  )
  const commands: EditCommand[] = moves.length
    ? [{ type: 'clip.move', moves }, ...placed.commands]
    : placed.commands
  return { clip: placed.clip, commands }
}

/** What a drop on a hidden track says, during the drag and when let go. */
export const HIDDEN_TRACK_NOTE = 'Track is hidden: show it to insert'

/**
 * Where the media being dragged would land when dropped at `at`: the clip's span (on the track it would go to, or the
 * hovered one when it needs a new track), the clip it replaces with Alt held, where it goes in by insert, the drop
 * point for files (their length is not known until they are imported), or the locked or hidden track where nothing
 * lands. `trimmed`: it fills a gap shorter than itself. `elsewhere`: it goes on another track than the hovered one, or
 * on a new one, which says so at the pointer.
 */
export function mediaDropHint(at: MediaDropPoint): MediaDropHint | null {
  const { trackId, time } = at
  const project = editor.getProject()
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  if (track.locked) return { trackId, locked: true, at: Math.floor(time) }
  const asset = dragging ? project.assets[dragging] : undefined
  if (!asset) return { trackId, start: time, end: time }
  const under = replaced(project, at, asset)
  if (under && at.alt)
    return { trackId, start: under.start, end: under.start + under.duration, replace: true }
  const insert = insertFor(project, asset, at)
  if (insert === 'hidden') return { trackId, hidden: true, at: Math.floor(time) }
  if (insert) {
    const { start, duration, bars, pastSong } = insert
    return {
      trackId,
      start,
      end: start + duration,
      insert: {
        at: start,
        moved: insert.pushes.length,
        ...(bars ? { bars } : {}),
        ...(pastSong !== undefined ? { pastSong } : {}),
      },
      // At the insert point, not the shot's start: the hint stays the same while the pointer moves on one side of a cut.
      ...(under ? { canReplace: { trackId, at: start } } : {}),
    }
  }
  const canReplace = under ? { canReplace: { trackId, at: under.start } } : {}
  const placed = cardPlacement(project, asset, at)
  if (!placed) return null
  const span = { start: placed.clip.start, end: placed.clip.start + placed.clip.duration }
  const other = project.tracks.find((t) => t.id === placed.clip.trackId)
  if (!other)
    return {
      trackId,
      ...span,
      newTrack: true,
      elsewhere: { trackId, at: at.pointer, name: 'a new track' },
      ...canReplace,
    }
  return {
    trackId: other.id,
    ...span,
    ...(placed.trimmed ? { trimmed: true as const } : {}),
    ...(other.id === trackId ? {} : { elsewhere: { trackId, at: at.pointer, name: other.name } }),
    ...canReplace,
  }
}

/**
 * What an insert's toast says: where it went in, that it was trimmed to whole bars, how many clips moved and how far,
 * and how long after the song the video now ends.
 */
function insertedMessage(name: string, plan: InsertPlan): string {
  const n = plan.pushes.length
  const sentences = [
    `Inserted “${name}” at ${formatTime(plan.start, true)}${plan.bars ? `, trimmed to ${plural(plan.bars, 'bar')} to stay on the beat` : ''}`,
    n && `The ${n === 1 ? 'clip' : plural(n, 'clip')} after it moved ${plan.duration.toFixed(1)} s later`,
    plan.pastSong !== undefined && `The video now ends ${plan.pastSong.toFixed(1)} s after the song`,
  ].filter(Boolean)
  return sentences.length > 1 ? `${sentences.join('. ')}.` : (sentences[0] as string)
}

/**
 * Puts a card's media on the timeline as a drop at `at` puts it (by insert, in a gap, or where it fits), selects it and
 * says where it landed when that isn't plainly where it was dropped: trimmed to a gap, on another track, or by insert
 * (see insertedMessage).
 */
export function placeCard(asset: Asset, at: MediaDropPoint): void {
  const project = editor.getProject()
  const name = baseName(asset.name)
  const insert = insertFor(project, asset, at)
  if (insert === 'hidden') {
    toast(HIDDEN_TRACK_NOTE)
    return
  }
  if (insert) {
    const made = insertCommands(project, asset, insert)
    const label = `Insert ${name}`
    if (!made || !dispatch(made.commands, { label })) return
    select({ type: 'clip', id: made.clip.id })
    toast(insertedMessage(name, insert), undoAction(label))
    return
  }
  const placed = cardPlacement(project, asset, at)
  if (!placed) return
  const label = `Add ${name}`
  if (!dispatch(placed.commands, { label })) return
  select({ type: 'clip', id: placed.clip.id })
  const when = formatTime(placed.clip.start, true)
  const seconds = placed.clip.duration.toFixed(1)
  const hovered = project.tracks.find((t) => t.id === at.trackId)
  const landed = project.tracks.find((t) => t.id === placed.clip.trackId)
  const added = editor.getProject().tracks.find((t) => t.id === placed.clip.trackId)
  const toastFor = addedToast(
    placed.trimmed
      ? placed.fills
        ? `Added “${name}” at ${when}, trimmed to fill the ${seconds} s gap`
        : `Added “${name}” at ${when}, trimmed to ${seconds} s to end at the next clip`
      : !landed
        ? `Added “${name}” on a new track, ${added?.name ?? 'below'}, at ${when}`
        : landed.id !== at.trackId
          ? `Added “${name}” on ${landed.name} at ${when}: ${hovered?.name ?? 'that track'} is full there`
          : `Added “${name}” at ${when}`,
    [placed.clip.id],
  )
  toast(toastFor.message, undoAction(label), { fix: toastFor.fix })
}

/**
 * Adds the dropped card's media at the drop point as placeCard puts it, or imports the dropped files there; with Alt,
 * replaces the clip there.
 */
export function dropMedia(e: Dragged, at: MediaDropPoint): void {
  const project = editor.getProject()
  const assetId = e.dataTransfer?.getData(MEDIA_DRAG_TYPE) || dragging
  dragging = null
  if (project.tracks.find((t) => t.id === at.trackId)?.locked) {
    toast('Track is locked')
    return
  }
  const asset = assetId ? project.assets[assetId] : undefined
  const under = at.alt ? replaced(project, at, asset) : undefined
  if (under && asset) {
    replaceClipMedia(under.id, asset.id)
    return
  }
  if (!asset) {
    void importFiles([...(e.dataTransfer?.files ?? [])], { start: at.time, trackId: at.trackId })
    return
  }
  placeCard(asset, at)
}

/**
 * Where Insert media… puts a video or image at `time`: on `trackId`, or else the lowest shown track with a video clip or
 * image there (the footage under the overlays), else the lowest shown one with any. A hidden track only when every track
 * with footage is hidden, where the insert is refused. Null when no track holds footage.
 */
export function insertTarget(project: Project, time: Seconds, trackId?: string): MediaDropPoint | null {
  const point = (id: string): MediaDropPoint => ({ trackId: id, time, pointer: time, alt: false, mod: true })
  if (trackId) return point(trackId)
  const footage = project.tracks
    .filter((t) => {
      const clips = trackClips(project, t.id)
      return t.kind === 'visual' && clips.some(isReplaceable) && !clips.some(isLookClip)
    })
    .reverse()
  const shown = footage.filter((t) => !t.hidden)
  const pool = shown.length ? shown : footage
  const track = pool.find((t) => shotAt(project, t.id, time)) ?? pool[0]
  return track ? point(track.id) : null
}
