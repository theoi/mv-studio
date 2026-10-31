import { memo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { Marker } from '../../../../model/index.ts'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../../ds/Menu.tsx'
import { formatTime } from '../../../format.ts'
import { moveMarker, removeMarker, renameMarker } from '../../../state/markers.ts'
import { editor } from '../../../state/project.ts'
import { get, set } from '../../../state/ui.ts'
import styles from './Markers.module.css'

/** Narrower than this, a marker shows its flag without its name. */
const MIN_LABEL_PX = 24

/**
 * Song markers on the ruler. Click one to go to it, drag it to move it, double-click (or F2) to rename it; its menu
 * goes to, renames or removes it. Arrow keys nudge a focused marker, Delete removes it.
 */
export const Markers = memo(function Markers({ markers, pps }: { markers: readonly Marker[]; pps: number }) {
  const [renaming, setRenaming] = useState<string | null>(null)
  return markers.map((m, i) => {
    const next = markers[i + 1]
    return (
      <MarkerFlag
        key={m.id}
        marker={m}
        pps={pps}
        labelWidth={Math.min(160, next ? (next.time - m.time) * pps - 12 : 160)}
        renaming={renaming === m.id}
        setRenaming={setRenaming}
      />
    )
  })
})

function MarkerFlag({
  marker,
  pps,
  labelWidth,
  renaming,
  setRenaming,
}: {
  marker: Marker
  pps: number
  labelWidth: number
  renaming: boolean
  setRenaming: (id: string | null) => void
}) {
  const goTo = () => set({ playhead: marker.time, playing: false })

  const startDrag = (e: PointerEvent<HTMLButtonElement>) => {
    // The ruler under it would move the playhead, and for a right-click capture the pointer so the menu never opens.
    e.stopPropagation()
    if (e.button !== 0) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const t0 = marker.time
    let moved = false
    const move = (ev: globalThis.PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return
      moved = true
      moveMarker(marker.id, t0 + (ev.clientX - x0) / get().pxPerSec, true)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (moved) editor.endGesture()
      else goTo()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter') goTo()
    else if (e.key === 'F2') setRenaming(marker.id)
    else if (e.key === 'Delete' || e.key === 'Backspace') removeMarker(marker.id)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      moveMarker(marker.id, marker.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1))
    else return
    // Handled here: not the playhead, split or delete-clip shortcuts.
    e.preventDefault()
    e.stopPropagation()
  }

  const left = marker.time * pps
  const style = (marker.color ? { left, '--marker': marker.color } : { left }) as CSSProperties

  if (renaming)
    return (
      <input
        className={styles.rename}
        style={{ left }}
        autoFocus
        defaultValue={marker.label}
        aria-label="Rename marker"
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          renameMarker(marker.id, e.target.value)
          setRenaming(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.value = marker.label
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
          e.stopPropagation()
        }}
      />
    )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={styles.marker}
          style={style}
          aria-label={`${marker.label}, marker at ${formatTime(marker.time, true)}`}
          onPointerDown={startDrag}
          onDoubleClick={() => setRenaming(marker.id)}
          onKeyDown={onKeyDown}
        >
          <span className={styles.flag} aria-hidden />
          {labelWidth >= MIN_LABEL_PX && (
            <span className={styles.label} style={{ maxWidth: labelWidth }}>
              {marker.label}
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem shortcut="Enter" onSelect={goTo}>
          Go to marker
        </ContextMenuItem>
        <ContextMenuItem shortcut="F2" onSelect={() => setRenaming(marker.id)}>
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger shortcut="Delete" onSelect={() => removeMarker(marker.id)}>
          Remove marker
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
