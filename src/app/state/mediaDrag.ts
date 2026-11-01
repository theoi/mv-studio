import type { Seconds } from '../../model/index.ts'
import { addAsset, assetPlacement, importFiles } from './importer.ts'
import type { LibraryDropHint } from './library.ts'
import { editor } from './project.ts'
import { replaceableAt, replaceClipMedia } from './replace.ts'
import { toast } from './ui.ts'

/*
 * Media dragged onto the timeline: Library › Media cards, and files from the computer. Either lands where it is
 * dropped, on that track when it fits there. A card dropped on a video clip or image with Alt held replaces what the
 * clip shows instead.
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

/**
 * Where the media being dragged would land when dropped at `at`: the clip's span (on the track it would go to, or the
 * hovered one when it needs a new track), the clip it replaces with Alt held, the drop point for files (their length is
 * not known until they are imported), or the locked track where nothing lands.
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
  const placed = assetPlacement(project, asset, { start: time, trackId })
  if (!placed) return null
  const span = { start: placed.clip.start, end: placed.clip.start + placed.clip.duration }
  const canReplace = under ? { canReplace: { trackId, at: under.start } } : {}
  return project.tracks.some((t) => t.id === placed.clip.trackId)
    ? { trackId: placed.clip.trackId, ...span, ...canReplace }
    : { trackId, ...span, newTrack: true, ...canReplace }
}

/** Adds the dropped card's media, or imports the dropped files, at the drop point; with Alt, replaces the clip there. */
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
  const placement = { start: at.time, trackId: at.trackId }
  if (assetId && project.assets[assetId]) addAsset(assetId, placement)
  else void importFiles([...(e.dataTransfer?.files ?? [])], placement)
}
