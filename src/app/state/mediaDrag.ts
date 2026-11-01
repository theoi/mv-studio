import type { Asset, Project, Seconds } from '../../model/index.ts'
import { formatTime } from '../format.ts'
import { gapAt } from './clipDrag.ts'
import { assetPlacement, baseName, importFiles } from './importer.ts'
import { undoAction, type LibraryDropHint } from './library.ts'
import { barsToSeconds } from './prefs.ts'
import { bpmOf, dispatch, editor } from './project.ts'
import { replaceableAt, replaceClipMedia } from './replace.ts'
import { addedToast } from './shotSound.ts'
import { select, toast } from './ui.ts'

/*
 * Media dragged onto the timeline: Library › Media cards, and files from the computer. Either lands where it is
 * dropped, on that track when it fits there; a card dropped in a gap between clips fills it. A card dropped on a video
 * clip or image with Alt held replaces what the clip shows instead.
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
 * Where dragged media would land. `newTrack`: it needs a track of its own, so its span is shown on the hovered one.
 * `replace`: the span is the clip it replaces. `canReplace`: the pointer is on a clip that Alt would replace instead.
 */
export type MediaDropHint =
  | Extract<LibraryDropHint, { locked: true }>
  | {
      trackId: string
      start: Seconds
      end: Seconds
      newTrack?: true
      replace?: true
      trimmed?: true
      elsewhere?: { trackId: string; at: Seconds; name: string }
      canReplace?: { trackId: string; at: Seconds }
    }

/** Where the pointer is over a track while media is dragged: `time` snapped for placing, `pointer` as it is. */
export interface MediaDropPoint {
  trackId: string
  time: Seconds
  pointer: Seconds
  /** Alt is held: a card on a video clip or image replaces what it shows. */
  alt: boolean
}

/** The clip a card being dragged replaces when dropped at `at` with Alt held, if it is a video or image. */
function replaced(at: MediaDropPoint, assetId: string | null) {
  const project = editor.getProject()
  const asset = assetId ? project.assets[assetId] : undefined
  if (asset?.kind !== 'video' && asset?.kind !== 'image') return undefined
  return replaceableAt(project, at.trackId, at.pointer)
}

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
 * Where the media being dragged would land when dropped at `at`: the clip's span (on the track it would go to, or the
 * hovered one when it needs a new track), the clip it replaces with Alt held, the drop point for files (their length is
 * not known until they are imported), or the locked track where nothing lands. `trimmed`: it fills a gap shorter than
 * itself. `elsewhere`: it goes on another track than the hovered one, or on a new one, which says so at the pointer.
 */
export function mediaDropHint(at: MediaDropPoint): MediaDropHint | null {
  const { trackId, time } = at
  const project = editor.getProject()
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  if (track.locked) return { trackId, locked: true, at: Math.floor(time) }
  const asset = dragging ? project.assets[dragging] : undefined
  if (!asset) return { trackId, start: time, end: time }
  const under = replaced(at, dragging)
  if (under && at.alt)
    return { trackId, start: under.start, end: under.start + under.duration, replace: true }
  const placed = cardPlacement(project, asset, at)
  if (!placed) return null
  const span = { start: placed.clip.start, end: placed.clip.start + placed.clip.duration }
  const canReplace = under ? { canReplace: { trackId, at: under.start } } : {}
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
 * Adds the dropped card's media, or imports the dropped files, at the drop point; with Alt, replaces the clip there. A
 * card's toast says where it landed when that isn't plainly where it was dropped: trimmed to a gap, or on another
 * track.
 */
export function dropMedia(e: Dragged, at: MediaDropPoint): void {
  const project = editor.getProject()
  const assetId = e.dataTransfer?.getData(MEDIA_DRAG_TYPE) || dragging
  dragging = null
  if (project.tracks.find((t) => t.id === at.trackId)?.locked) {
    toast('Track is locked')
    return
  }
  const under = at.alt ? replaced(at, assetId) : undefined
  if (under && assetId) {
    replaceClipMedia(under.id, assetId)
    return
  }
  const asset = assetId ? project.assets[assetId] : undefined
  if (!asset) {
    void importFiles([...(e.dataTransfer?.files ?? [])], { start: at.time, trackId: at.trackId })
    return
  }
  const placed = cardPlacement(project, asset, at)
  if (!placed) return
  const name = baseName(asset.name)
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
