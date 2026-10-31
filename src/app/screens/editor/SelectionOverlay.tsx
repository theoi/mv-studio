import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Project } from '../../../model/index.ts'
import { usePick } from '../../state/pick.ts'
import { useProject } from '../../state/project.ts'
import { useUi } from '../../state/ui.ts'
import {
  blockedNote,
  canDrag,
  CLICK_SLOP,
  HANDLE_HIT,
  placeHandles,
  resizeCursor,
  startDrag,
  transformAt,
  type HandleMode,
  type Point,
  type Rect,
} from './handles.ts'
import { selectedClip, selectionOutline, showDraft } from './stage.ts'
import styles from './Preview.module.css'

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const
/** How long an outline without handles says why, unless the pointer is released sooner. */
const NOTE_MS = 2000
/** Half the note's width at most, to keep it on the stage. */
const NOTE_HALF_WIDTH = 160

/**
 * The selected clip's outline on the preview. Video, image and text clips also get handles: drag inside to move, a
 * corner to scale, the knob above to rotate. `view` is the part of the stage on screen, in frame pixels: handles stay
 * inside it, since the stage clips what is outside.
 */
export function SelectionOverlay({
  width,
  height,
  view,
}: {
  width: number
  height: number
  view: Rect | null
}) {
  const selection = useUi((s) => s.selection)
  const t = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const picking = usePick((s) => !!s.request)
  const saved = useProject()
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<HandleMode | null>(null)
  // The project as a drag in progress has it, ahead of the editor (see startDrag).
  const [draft, setDraft] = useState<Project | null>(null)
  const [note, setNote] = useState<{ clipId: string; text: string } | null>(null)
  const noteTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(noteTimer.current), [])
  const project = draft ?? saved
  if (playing || picking || !width) return null
  const corners = selectionOutline(project, selection, t, width, height)
  const clip = selectedClip(project, selection, t)
  if (!corners || !clip) return null
  const editable = canDrag(project, clip)
  const blocked = editable ? null : blockedNote(project, clip)
  const anchor = transformAt(clip, t - clip.start)
  const pivot: Point = [anchor.x * width, anchor.y * height]
  const placed = placeHandles(corners, pivot, view)

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

  // A drag on an outline without handles says why, until the pointer is released or NOTE_MS pass.
  const explain = (text: string) => (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    const from: Point = [e.clientX, e.clientY]
    const clipId = clip.id
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - from[0], ev.clientY - from[1]) < CLICK_SLOP) return
      window.removeEventListener('pointermove', move)
      setNote({ clipId, text })
      window.clearTimeout(noteTimer.current)
      noteTimer.current = window.setTimeout(() => setNote(null), NOTE_MS)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.clearTimeout(noteTimer.current)
      setNote(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const shownNote = note?.clipId === clip.id ? note.text : null
  // Above the outline, kept on the visible stage.
  const v = view ?? { x: 0, y: 0, width, height }
  const xs = corners.map((c) => c[0])
  const half = Math.min(NOTE_HALF_WIDTH, v.width / 2)
  const noteX = Math.min(Math.max((Math.min(...xs) + Math.max(...xs)) / 2, v.x + half), v.x + v.width - half)
  const noteY = Math.min(Math.max(Math.min(...corners.map((c) => c[1])) - 8, v.y + 40), v.y + v.height - 8)

  return (
    <>
      <svg
        ref={svgRef}
        className={styles.overlay}
        width={width}
        height={height}
        aria-hidden
        data-dragging={dragging ?? undefined}
      >
        <polygon
          className={[styles.selBox, editable ? styles.selBody : blocked && styles.selStatic]
            .filter(Boolean)
            .join(' ')}
          points={corners.map((c) => c.join(',')).join(' ')}
          data-handle={editable ? 'move' : undefined}
          onPointerDown={editable ? begin('move') : blocked ? explain(blocked) : undefined}
        />
        {editable && placed.stem && (
          <line
            className={styles.selStem}
            x1={placed.stem[0][0]}
            y1={placed.stem[0][1]}
            x2={placed.stem[1][0]}
            y2={placed.stem[1][1]}
          />
        )}
        {(editable ? placed.corners : corners).map(([x, y], i) => (
          <rect key={i} className={styles.selHandle} x={x - 3.5} y={y - 3.5} width={7} height={7} />
        ))}
        {editable && (
          <>
            <circle className={styles.selHandle} cx={placed.knob[0]} cy={placed.knob[1]} r={4} />
            {placed.corners.map((c, i) => (
              <rect
                key={CORNERS[i]}
                className={styles.selHit}
                x={c[0] - HANDLE_HIT / 2}
                y={c[1] - HANDLE_HIT / 2}
                width={HANDLE_HIT}
                height={HANDLE_HIT}
                style={{ cursor: resizeCursor(corners, i) }}
                data-handle={CORNERS[i]}
                onPointerDown={begin('scale')}
              />
            ))}
            <circle
              className={[styles.selHit, styles.selRotate].join(' ')}
              cx={placed.knob[0]}
              cy={placed.knob[1]}
              r={HANDLE_HIT / 2}
              data-handle="rotate"
              onPointerDown={begin('rotate')}
            />
          </>
        )}
      </svg>
      <div className={styles.selNoteRegion} role="status">
        {shownNote && (
          <span className={styles.selNote} style={{ left: noteX, top: noteY }}>
            {shownNote}
          </span>
        )}
      </div>
    </>
  )
}
