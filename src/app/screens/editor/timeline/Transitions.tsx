import { Blend } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../../ds/Menu.tsx'
import { formatTime } from '../../../format.ts'
import { useProject } from '../../../state/project.ts'
import { removeTransition, transitionSpots, type TransitionSpot } from '../../../state/transitions.ts'
import { select, useUi } from '../../../state/ui.ts'
import styles from './Timeline.module.css'

/** At least 24 px to click at any zoom; a name shows once the transition is wide enough for one. */
const MIN_W = 24
const NAME_W = 72

function Mark({ spot, pps, selected }: { spot: TransitionSpot; pps: number; selected: boolean }) {
  const name = pluginRegistry.get(spot.transition.kind)?.name ?? 'Transition'
  const width = Math.max(MIN_W, (spot.end - spot.start) * pps)
  const left = spot.edge === 'in' ? spot.start * pps : spot.end * pps - width
  const pick = () => select({ type: 'transition', id: spot.clipId, edge: spot.edge })
  return (
    <ContextMenu onOpenChange={(open) => open && pick()}>
      <ContextMenuTrigger asChild>
        <button
          className={[styles.transition, selected && styles.transitionSel].filter(Boolean).join(' ')}
          style={{ left, width }}
          aria-label={`Transition: ${name}, ${formatTime(spot.start, true)}`}
          aria-pressed={selected}
          // Over the clip it belongs to: a press here selects the transition, not the clip under it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={pick}
        >
          <Blend />
          {width >= NAME_W && <span className={styles.transitionName}>{name}</span>}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem danger onSelect={() => removeTransition(spot.clipId, spot.edge)}>
          Remove transition
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A track's transitions, as small marks over the clips they belong to. */
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
