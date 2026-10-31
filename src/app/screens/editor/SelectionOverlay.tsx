import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Project } from '../../../model/index.ts'
import { usePick } from '../../state/pick.ts'
import { useProject } from '../../state/project.ts'
import { useUi } from '../../state/ui.ts'
import {
  canDrag,
  knobOf,
  resizeCursor,
  startDrag,
  transformAt,
  type HandleMode,
  type Point,
} from './handles.ts'
import { selectedClip, selectionOutline, showDraft } from './stage.ts'
import styles from './Preview.module.css'

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const

/**
 * The selected clip's outline on the preview. Clips with Inspector › Transform also get handles: drag inside to move,
 * a corner to scale, the knob above to rotate.
 */
export function SelectionOverlay({ width, height }: { width: number; height: number }) {
  const selection = useUi((s) => s.selection)
  const t = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const picking = usePick((s) => !!s.request)
  const saved = useProject()
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<HandleMode | null>(null)
  // The project as a drag in progress has it, ahead of the editor (see startDrag).
  const [draft, setDraft] = useState<Project | null>(null)
  const project = draft ?? saved
  if (playing || picking || !width) return null
  const corners = selectionOutline(project, selection, t, width, height)
  const clip = selectedClip(project, selection, t)
  if (!corners || !clip) return null
  const editable = canDrag(project, clip)
  const { topMid, knob } = knobOf(corners)
  const anchor = transformAt(clip, t - clip.start)
  const pivot: Point = [anchor.x * width, anchor.y * height]

  const begin = (mode: HandleMode) => (e: ReactPointerEvent<SVGElement>) => {
    const svg = svgRef.current
    if (e.button !== 0 || !svg) return
    e.preventDefault()
    const box = svg.getBoundingClientRect()
    const at = (ev: PointerEvent): Point => [ev.clientX - box.left, ev.clientY - box.top]
    const show = (p: Project | null) => {
      setDraft(p)
      showDraft(p)
    }
    const drag = startDrag(mode, clip, t - clip.start, at(e.nativeEvent), { width, height }, show)
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(mode)
    const move = (ev: PointerEvent) => drag.update(at(ev), ev.shiftKey)
    // On the window, so the drag still ends if the handle unmounts (playback started) before the button is released.
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      drag.end()
      setDragging(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  return (
    <svg
      ref={svgRef}
      className={styles.overlay}
      width={width}
      height={height}
      aria-hidden
      data-dragging={dragging ?? undefined}
    >
      <polygon
        className={[styles.selBox, editable && styles.selBody].filter(Boolean).join(' ')}
        points={corners.map((c) => c.join(',')).join(' ')}
        data-handle={editable ? 'move' : undefined}
        onPointerDown={editable ? begin('move') : undefined}
      />
      {editable && (
        <line className={styles.selStem} x1={topMid[0]} y1={topMid[1]} x2={knob[0]} y2={knob[1]} />
      )}
      {corners.map(([x, y], i) => (
        <rect key={i} className={styles.selHandle} x={x - 3.5} y={y - 3.5} width={7} height={7} />
      ))}
      {editable && (
        <>
          <circle className={styles.selHandle} cx={knob[0]} cy={knob[1]} r={4} />
          {corners.map((c, i) => (
            <rect
              key={CORNERS[i]}
              className={styles.selHit}
              x={c[0] - 8}
              y={c[1] - 8}
              width={16}
              height={16}
              style={{ cursor: resizeCursor(c, pivot) }}
              data-handle={CORNERS[i]}
              onPointerDown={begin('scale')}
            />
          ))}
          <circle
            className={[styles.selHit, styles.selRotate].join(' ')}
            cx={knob[0]}
            cy={knob[1]}
            r={10}
            data-handle="rotate"
            onPointerDown={begin('rotate')}
          />
        </>
      )}
    </svg>
  )
}
