import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Kbd } from '../../ds/Kbd.tsx'
import { cancelPick, pickAt, usePick } from '../../state/pick.ts'
import styles from './Preview.module.css'

const STEP = 0.01
const FAST_STEP = 0.05
const CENTER = { x: 0.5, y: 0.5 }
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

function pointIn(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
}

/** Where focus goes when pick mode ends: the element that started it, else the first button of its panel. */
function returnFocus(before: HTMLElement | null, panel: Element | null) {
  if (document.activeElement?.closest('[role="dialog"]')) return
  const target = before?.isConnected
    ? before
    : panel?.isConnected
      ? panel.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]')
      : null
  target?.focus({ preventScroll: true })
}

/** Takes one click on the preview for the feature that started pick mode (state/pick.ts). */
export function PickOverlay({ width, height }: { width: number; height: number }) {
  const request = usePick((s) => s.request)
  const ref = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [aiming, setAiming] = useState(false)

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = before?.closest('[role="tabpanel"]') ?? null
    ref.current?.focus({ preventScroll: true })
    // Capture phase on window, so Esc cancels the pick wherever focus is, before other Esc handlers see it.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      cancelPick()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      returnFocus(before, panel)
    }
  }, [])

  if (!request || !width) return null
  const outline = point ? request.hover?.(point) : null
  const cross = point ?? CENTER

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const arrow = ARROWS[e.key]
    if (arrow) {
      e.preventDefault()
      e.stopPropagation()
      const step = e.shiftKey ? FAST_STEP : STEP
      const from = point ?? CENTER
      setAiming(true)
      setPoint({
        x: Math.min(1, Math.max(0, from.x + arrow[0] * step)),
        y: Math.min(1, Math.max(0, from.y + arrow[1] * step)),
      })
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      const at = point ?? CENTER
      pickAt(at.x, at.y)
    } else if (e.key !== 'Tab' && !e.metaKey && !e.ctrlKey) {
      // Pick mode is modal for the keyboard: editor shortcuts (S splits, T adds text, ...) wait until it ends.
      // Undo and redo still work.
      e.stopPropagation()
    }
  }

  return (
    <div
      ref={ref}
      className={styles.pickLayer}
      tabIndex={0}
      role="button"
      aria-label={request.prompt}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter Escape"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        // Started from the keyboard: show where Enter will pick right away.
        if (!e.currentTarget.matches(':focus-visible')) return
        setAiming(true)
        setPoint((p) => p ?? CENTER)
      }}
      onPointerMove={(e) => {
        setAiming(false)
        setPoint(pointIn(e))
      }}
      onPointerLeave={() => {
        if (!aiming) setPoint(null)
      }}
      onClick={(e) => {
        const at = pointIn(e)
        pickAt(at.x, at.y)
      }}
    >
      <svg className={styles.overlay} width={width} height={height} aria-hidden>
        {outline && (
          <polygon
            className={styles.selBox}
            points={outline.map(([x, y]) => `${x * width},${y * height}`).join(' ')}
          />
        )}
        {aiming && (
          <g className={styles.pickCross}>
            <circle cx={cross.x * width} cy={cross.y * height} r={9} />
            <path
              d={`M${cross.x * width - 15} ${cross.y * height}h9M${cross.x * width + 6} ${cross.y * height}h9M${
                cross.x * width
              } ${cross.y * height - 15}v9M${cross.x * width} ${cross.y * height + 6}v9`}
            />
          </g>
        )}
      </svg>
      <div className={styles.pickNote}>
        <span className={styles.pickPrompt}>{request.prompt}</span>
        <span className={styles.pickHint}>
          {aiming && (
            <>
              Arrows to aim · <Kbd keys="Enter" /> to pick ·
            </>
          )}
          <Kbd keys="Esc" /> to cancel
        </span>
      </div>
    </div>
  )
}
