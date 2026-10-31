import styles from './Editor.module.css'

interface SplitterProps {
  orientation: 'vertical' | 'horizontal'
  className?: string
  label: string
  getStart: () => number
  onDrag: (dx: number, start: number, dy: number) => void
}

/** Invisible hit area on a panel edge; shows an accent line while hovered or dragged. */
export function Splitter({ orientation, className, label, getStart, onDrag }: SplitterProps) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    el.dataset.dragging = 'true'
    const x0 = e.clientX
    const y0 = e.clientY
    const start = getStart()
    let frame = 0
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => onDrag(ev.clientX - x0, start, ev.clientY - y0))
    }
    const up = () => {
      delete el.dataset.dragging
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      className={[
        styles.splitter,
        orientation === 'vertical' ? styles.splitterV : styles.splitterH,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onPointerDown={onPointerDown}
    />
  )
}
