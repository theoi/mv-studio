import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Kbd } from '../../ds/Kbd.tsx'
import { cancelPick, pickAt, usePick } from '../../state/pick.ts'
import styles from './Preview.module.css'

const STEP = 0.01
const FAST_STEP = 0.05
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

/** Takes one click on the preview for the feature that started pick mode (state/pick.ts). */
export function PickOverlay({ width, height }: { width: number; height: number }) {
  const request = usePick((s) => s.request)
  const ref = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [aiming, setAiming] = useState(false)

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
      if (before?.isConnected && !document.activeElement?.closest('[role="dialog"]'))
        before.focus({ preventScroll: true })
    }
  }, [])

  if (!request || !width) return null
  const outline = point ? request.hover?.(point) : null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const arrow = ARROWS[e.key]
    if (arrow) {
      e.preventDefault()
      e.stopPropagation()
      const step = e.shiftKey ? FAST_STEP : STEP
      const from = point ?? { x: 0.5, y: 0.5 }
      setAiming(true)
      setPoint({
        x: Math.min(1, Math.max(0, from.x + arrow[0] * step)),
        y: Math.min(1, Math.max(0, from.y + arrow[1] * step)),
      })
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      const at = point ?? { x: 0.5, y: 0.5 }
      pickAt(at.x, at.y)
    }
  }

  return (
    <div
      ref={ref}
      className={styles.pickLayer}
      tabIndex={0}
      role="button"
      aria-label={request.prompt}
      aria-keyshortcuts="Enter Escape"
      onKeyDown={onKeyDown}
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
            <circle cx={(point?.x ?? 0.5) * width} cy={(point?.y ?? 0.5) * height} r={9} />
            <path
              d={(() => {
                const x = (point?.x ?? 0.5) * width
                const y = (point?.y ?? 0.5) * height
                return `M${x - 15} ${y}h9M${x + 6} ${y}h9M${x} ${y - 15}v9M${x} ${y + 6}v9`
              })()}
            />
          </g>
        )}
      </svg>
      <div className={styles.pickNote}>
        <span className={styles.pickPrompt}>{request.prompt}</span>
        <span className={styles.pickHint}>
          <Kbd keys="Esc" /> to cancel
        </span>
      </div>
    </div>
  )
}
