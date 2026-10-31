import type { MouseEvent } from 'react'
import { create } from 'zustand'
import { gapAt } from '../../../state/generate.ts'
import { editor } from '../../../state/project.ts'

interface GapPoint {
  trackId: string
  time: number
  x: number
  y: number
}

/** The empty stretch of the timeline whose menu is open, and where it was right-clicked. */
export const useGapMenu = create<{ at: GapPoint | null }>(() => ({ at: null }))

/**
 * Right-click on a track's lane: opens the menu for the empty stretch there. Clicks on clips (which have their own
 * menu) and anything else on the lane are left alone.
 */
export function openGapMenu(e: MouseEvent<HTMLElement>, trackId: string, time: number): void {
  if (e.target !== e.currentTarget || e.defaultPrevented) return
  if (!gapAt(editor.getProject(), trackId, time)) return
  e.preventDefault()
  useGapMenu.setState({ at: { trackId, time, x: e.clientX, y: e.clientY } })
}
