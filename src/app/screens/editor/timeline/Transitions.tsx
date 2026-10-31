import { memo, useRef } from 'react'
import { Blend } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatTime } from '../../../format.ts'
import {
  focusClip,
  removeTransition,
  transitionName,
  transitionSeconds,
  type PlacedMark,
} from '../../../state/transitions.ts'
import { select } from '../../../state/ui.ts'
import styles from './Timeline.module.css'

/** A name shows once the transition is wide enough for one. */
const NAME_W = 72

function TransitionMarkView({ mark, selected }: { mark: PlacedMark; selected: boolean }) {
  const name = transitionName(mark.transition)
  const pick = () => select({ type: 'transition', id: mark.clipId, edge: mark.edge })
  // Set by Remove transition, so the closing menu hands focus to the clip instead of the page.
  const removedFromMenu = useRef(false)
  return (
    <ContextMenu onOpenChange={(open) => open && pick()}>
      {/* Above, so it does not cover the clip under the mark and catch the next click meant for it. */}
      <Tooltip label={`${name} · ${transitionSeconds(mark.transition.duration)}`} side="top">
        <ContextMenuTrigger asChild>
          <button
            className={[styles.transition, selected && styles.transitionSel].filter(Boolean).join(' ')}
            style={{ left: mark.left, width: mark.width }}
            aria-label={`Transition: ${name}, ${formatTime(mark.start, true)}`}
            aria-pressed={selected}
            // A press on the mark selects the transition, not the clip under it.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pick}
          >
            <span className={styles.transitionChip}>
              <Blend />
              {mark.width >= NAME_W && <span className={styles.transitionName}>{name}</span>}
            </span>
          </button>
        </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (!removedFromMenu.current) return
          removedFromMenu.current = false
          e.preventDefault()
          focusClip(mark.clipId)
        }}
      >
        <ContextMenuItem
          danger
          shortcut="Delete"
          onSelect={() => {
            removedFromMenu.current = true
            removeTransition(mark.clipId, mark.edge)
          }}
        >
          Remove transition
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * A transition's mark on the top edge of the clip it belongs to. The timeline renders it right after that clip, so
 * Tab goes from the clip to its transitions and then to the next clip.
 */
export const TransitionMark = memo(
  TransitionMarkView,
  (a, b) =>
    a.selected === b.selected &&
    a.mark.clipId === b.mark.clipId &&
    a.mark.edge === b.mark.edge &&
    a.mark.transition === b.mark.transition &&
    a.mark.start === b.mark.start &&
    a.mark.left === b.mark.left &&
    a.mark.width === b.mark.width,
)
