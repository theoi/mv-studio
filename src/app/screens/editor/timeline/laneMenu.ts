import type { ComponentType, MouseEvent } from 'react'
import { Sparkles } from 'lucide-react'
import { create } from 'zustand'
import { clipsOnTrack, type Project } from '../../../../model/index.ts'
import { formatTime } from '../../../format.ts'
import { cloudSettings } from '../../../state/cloud.ts'
import { gapAt, generateInGap, shotStart } from '../../../state/generate.ts'
import { editor, isLookClip } from '../../../state/project.ts'

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

/** The lane menu's items, in order. Generate a shot here stays last. */
export const LANE_ITEMS: LaneItem[] = [generateShot]

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
