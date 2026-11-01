import type { ComponentType, MouseEvent } from 'react'
import { ClipboardPaste, FoldHorizontal, Sparkles } from 'lucide-react'
import { create } from 'zustand'
import { clipsOnTrack, type Project } from '../../../../model/index.ts'
import { formatTime } from '../../../format.ts'
import { hasClipboard, pasteAt, pasteHereOutcome, type PasteHereOutcome } from '../../../state/clipboard.ts'
import { cloudSettings } from '../../../state/cloud.ts'
import { gapAt } from '../../../state/clipDrag.ts'
import { generateInGap, shotStart } from '../../../state/generate.ts'
import { editor, isLookClip, sectionsOf } from '../../../state/project.ts'
import { closeGap, gapLength, gapToClose } from '../../../state/ripple.ts'
import { get } from '../../../state/ui.ts'
import { beatGridOf } from '../../../../vj/quantize.ts'

/** Where a lane was right-clicked: the track and the time under the pointer. */
export interface LaneSpot {
  trackId: string
  time: number
}

/**
 * One entry of the lane menu (right-click on a timeline lane where there is no clip). To add one, write a LaneItem
 * and list it in LANE_ITEMS: the menu shows every item whose `applies` is true for the spot, in list order, with a
 * separator between groups. The menu opens only when at least one item applies.
 */
export interface LaneItem {
  /** Items of one group sit together; a separator goes between groups. */
  group: string
  label: string
  icon?: ComponentType
  /** Shown on the right, e.g. "Mod V". */
  shortcut?: string
  /** Whether the item is offered at this spot. */
  applies: (project: Project, spot: LaneSpot) => boolean
  /** A second line under the label. */
  description?: (project: Project, spot: LaneSpot) => string
  /** Shown but not clickable; say why in the description. */
  disabled?: (project: Project, spot: LaneSpot) => boolean
  run: (spot: LaneSpot) => void
}

/** Video and overlay tracks: visual tracks that are not the lyrics or the look track. */
function holdsShots(project: Project, trackId: string): boolean {
  if (project.tracks.find((t) => t.id === trackId)?.kind !== 'visual') return false
  const clips = clipsOnTrack(project, trackId)
  return !clips.length || !(clips.every((c) => c.type === 'text' && c.lyricLineId) || clips.every(isLookClip))
}

const locked = (project: Project, { trackId }: LaneSpot) =>
  project.tracks.find((t) => t.id === trackId)?.locked === true

const generateShot: LaneItem = {
  group: 'generate',
  label: 'Generate a shot here',
  icon: Sparkles,
  applies: (project, spot) =>
    holdsShots(project, spot.trackId) && gapAt(project, spot.trackId, spot.time) !== null,
  description: (project, spot) => {
    if (locked(project, spot)) return 'The track is locked'
    const gap = gapAt(project, spot.trackId, spot.time)
    const at = gap ? shotStart(project, gap, spot.time) : spot.time
    return `AI image or clip at ${formatTime(at)}${cloudSettings.get().falKey ? '' : ' · needs fal.ai'}`
  },
  disabled: locked,
  run: (spot) => generateInGap(spot.trackId, spot.time),
}

/**
 * Where Generate a shot here goes at `time` when it isn't picked on a lane (the command palette): the preferred
 * track, else the first track with an empty spot there. Null with why when there is none.
 */
export function generateSpotAt(
  project: Project,
  time: number,
  preferTrackId?: string,
): LaneSpot | { why: string } {
  const spots = [...new Set([preferTrackId, ...project.tracks.map((t) => t.id)])]
    .filter((trackId): trackId is string => !!trackId)
    .map((trackId) => ({ trackId, time }))
    .filter((spot) => generateShot.applies(project, spot))
  const open = spots.find((spot) => !locked(project, spot))
  if (open) return open
  return { why: spots.length ? 'The track is locked' : 'No empty spot on a video track at the playhead' }
}

export function generateShotAt(spot: LaneSpot): void {
  generateShot.run(spot)
}

/** Snapping distance on screen, as for dragged clips. */
const SNAP_PX = 8

/**
 * Where Paste here puts the first copied clip: the right-clicked time, snapped like a dropped clip when snapping is on
 * (to the track's clip edges, the playhead, section starts, and the song's beats with beat snapping).
 */
export function pasteHereTime(project: Project, spot: LaneSpot): number {
  const { snap, beatSnap, playhead, pxPerSec } = get()
  if (!snap) return spot.time
  const targets = [
    ...clipsOnTrack(project, spot.trackId).flatMap((c) => [c.start, c.start + c.duration]),
    playhead,
    ...sectionsOf(project).map((s) => s.start),
    ...(beatSnap ? (beatGridOf(project)?.beats ?? []) : []),
  ]
  let best = spot.time
  let distance = SNAP_PX / pxPerSec
  for (const t of targets) {
    if (Math.abs(t - spot.time) >= distance) continue
    best = t
    distance = Math.abs(t - spot.time)
  }
  return best
}

const WHERE: Record<PasteHereOutcome, string> = {
  here: '',
  own: ' · on their own tracks',
  new: ' · on a new track',
  'new-tracks': ' · on new tracks',
  mixed: ' · on several tracks',
}

const pasteHere: LaneItem = {
  group: 'clipboard',
  label: 'Paste here',
  icon: ClipboardPaste,
  applies: () => true,
  description: (project, spot) => {
    const time = pasteHereTime(project, spot)
    const outcome = pasteHereOutcome(project, spot.trackId, time)
    return outcome ? `At ${formatTime(time, true)}${WHERE[outcome]}` : 'Copy clips first'
  },
  disabled: () => !hasClipboard(),
  run: (spot) => pasteAt(spot.trackId, pasteHereTime(editor.getProject(), spot)),
}

const closeGapHere: LaneItem = {
  group: 'gap',
  label: 'Close gap',
  icon: FoldHorizontal,
  applies: (project, spot) => gapToClose(project, spot.trackId, spot.time) !== null,
  description: (project, spot) => {
    if (locked(project, spot)) return 'The track is locked'
    const gap = gapToClose(project, spot.trackId, spot.time)
    return gap ? `${gapLength(gap)} · the later clips move left` : ''
  },
  disabled: locked,
  run: (spot) => {
    const gap = gapToClose(editor.getProject(), spot.trackId, spot.time)
    if (gap) closeGap(gap)
  },
}

/** The lane menu's items, in order. Generate a shot here stays last. */
export const LANE_ITEMS: LaneItem[] = [pasteHere, closeGapHere, generateShot]

/** The items offered at a spot. */
export function laneItemsAt(project: Project, spot: LaneSpot): LaneItem[] {
  return LANE_ITEMS.filter((item) => item.applies(project, spot))
}

/** The spot whose menu is open, and where on screen it was right-clicked. */
export const useLaneMenu = create<{ at: (LaneSpot & { x: number; y: number }) | null }>(() => ({ at: null }))

/**
 * A lane's onContextMenu: opens the lane menu when an item applies there. Right-clicks on clips (which have their own
 * menu) and on anything else inside the lane are left alone, as are spots where no item applies.
 */
export function openLaneMenu(e: MouseEvent<HTMLElement>, trackId: string, time: number): void {
  if (e.target !== e.currentTarget || e.defaultPrevented) return
  if (!laneItemsAt(editor.getProject(), { trackId, time }).length) return
  e.preventDefault()
  useLaneMenu.setState({ at: { trackId, time, x: e.clientX, y: e.clientY } })
}
