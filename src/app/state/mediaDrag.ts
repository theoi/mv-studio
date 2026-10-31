import type { Seconds } from '../../model/index.ts'
import { addAsset, assetPlacement, importFiles } from './importer.ts'
import type { LibraryDropHint } from './library.ts'
import { editor } from './project.ts'
import { toast } from './ui.ts'

/*
 * Media dragged onto the timeline: Library › Media cards, and files from the computer. Either lands where it is
 * dropped, on that track when it fits there.
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

/** Where dragged media would land. `newTrack`: it needs a track of its own, so its span is shown on the hovered one. */
export type MediaDropHint =
  LibraryDropHint | { trackId: string; start: Seconds; end: Seconds; newTrack: true }

/**
 * Where the media being dragged would land when dropped on a track at `time`: the clip's span (on the track it would
 * go to, or the hovered one when it needs a new track), the drop point for files (their length is not known until
 * they are imported), or the locked track where nothing lands.
 */
export function mediaDropHint(trackId: string, time: Seconds): MediaDropHint | null {
  const project = editor.getProject()
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  if (track.locked) return { trackId, locked: true, at: Math.floor(time) }
  const asset = dragging ? project.assets[dragging] : undefined
  if (!asset) return { trackId, start: time, end: time }
  const placed = assetPlacement(project, asset, { start: time, trackId })
  if (!placed) return null
  const span = { start: placed.clip.start, end: placed.clip.start + placed.clip.duration }
  return project.tracks.some((t) => t.id === placed.clip.trackId)
    ? { trackId: placed.clip.trackId, ...span }
    : { trackId, ...span, newTrack: true }
}

/** Adds the dropped card's media, or imports the dropped files, at the drop point. */
export function dropMedia(e: Dragged, at: { trackId: string; time: Seconds }): void {
  const project = editor.getProject()
  const assetId = e.dataTransfer?.getData(MEDIA_DRAG_TYPE) || dragging
  dragging = null
  if (project.tracks.find((t) => t.id === at.trackId)?.locked) {
    toast('Track is locked')
    return
  }
  const placement = { start: at.time, trackId: at.trackId }
  if (assetId && project.assets[assetId]) addAsset(assetId, placement)
  else void importFiles([...(e.dataTransfer?.files ?? [])], placement)
}
