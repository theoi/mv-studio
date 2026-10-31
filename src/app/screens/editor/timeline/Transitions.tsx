import { useRef } from 'react'
import { Blend } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatTime } from '../../../format.ts'
import { useProject } from '../../../state/project.ts'
import {
  focusClip,
  removeTransition,
  transitionMarkWidth,
  transitionSeconds,
  transitionSpots,
  type TransitionSpot,
} from '../../../state/transitions.ts'
import { select, useUi } from '../../../state/ui.ts'
import styles from './Timeline.module.css'

/** A name shows once the transition is wide enough for one. */
const NAME_W = 72

function Mark({ spot, pps, selected }: { spot: TransitionSpot; pps: number; selected: boolean }) {
  const name = pluginRegistry.get(spot.transition.kind)?.name ?? 'Transition'
  const width = transitionMarkWidth(spot.end - spot.start, pps)
  const left = spot.edge === 'in' ? spot.start * pps : spot.end * pps - width
  const pick = () => select({ type: 'transition', id: spot.clipId, edge: spot.edge })
  // Set by Remove transition, so the closing menu hands focus to the clip instead of the page.
  const removedFromMenu = useRef(false)
  return (
    <ContextMenu onOpenChange={(open) => open && pick()}>
      {/* Above, so it does not cover the clip under the mark and catch the next click meant for it. */}
      <Tooltip label={`${name} · ${transitionSeconds(spot.transition.duration)}`} side="top">
        <ContextMenuTrigger asChild>
          <button
            className={[styles.transition, selected && styles.transitionSel].filter(Boolean).join(' ')}
            style={{ left, width }}
            aria-label={`Transition: ${name}, ${formatTime(spot.start, true)}`}
            aria-pressed={selected}
            // A press on the mark selects the transition, not the clip under it.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pick}
          >
            <span className={styles.transitionChip}>
              <Blend />
              {width >= NAME_W && <span className={styles.transitionName}>{name}</span>}
            </span>
          </button>
        </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (!removedFromMenu.current) return
          removedFromMenu.current = false
          e.preventDefault()
          focusClip(spot.clipId)
        }}
      >
        <ContextMenuItem
          danger
          shortcut="Delete"
          onSelect={() => {
            removedFromMenu.current = true
            removeTransition(spot.clipId, spot.edge)
          }}
        >
          Remove transition
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A track's transitions, as small marks on the top edge of the clips they belong to. */
export function TransitionMarks({ trackId, pps }: { trackId: string; pps: number }) {
  const project = useProject()
  const selection = useUi((s) => s.selection)
  return transitionSpots(project, trackId).map((spot) => (
    <Mark
      key={`${spot.clipId}:${spot.edge}`}
      spot={spot}
      pps={pps}
      selected={
        selection.type === 'transition' && selection.id === spot.clipId && selection.edge === spot.edge
      }
    />
  ))
}
