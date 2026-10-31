import {
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { Marker } from '../../../../model/index.ts'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../../ds/Menu.tsx'
import { Tooltip } from '../../../ds/Tooltip.tsx'
import { formatTime } from '../../../format.ts'
import {
  moveMarker,
  nudgeMarker,
  removeMarker,
  renameMarker,
  snapMarkerTime,
} from '../../../state/markers.ts'
import { editor } from '../../../state/project.ts'
import { get, set } from '../../../state/ui.ts'
import styles from './Markers.module.css'

/** Narrower than this, a marker shows its flag without its name. */
const MIN_LABEL_PX = 24

/** Where focus goes when the last marker is removed: the toolbar's Add marker button. */
const focusAddMarker = () => document.querySelector<HTMLElement>('[data-add-marker]')?.focus()

/**
 * Song markers on the ruler. Click one to go to it, drag it to move it, double-click (or F2) to rename it; its menu
 * goes to, renames or removes it. Arrow keys nudge a focused marker, Delete removes it.
 */
export const Markers = memo(function Markers({ markers, pps }: { markers: readonly Marker[]; pps: number }) {
  const [renaming, setRenaming] = useState<string | null>(null)
  // The marker to focus when it next renders: after a rename ends with Enter or Esc, or a neighbor is deleted.
  const focusNextRef = useRef<string | null>(null)
  const sorted = useMemo(() => [...markers].sort((a, b) => a.time - b.time), [markers])
  return sorted.map((m, i) => {
    const next = sorted[i + 1]
    return (
      <MarkerFlag
        key={m.id}
        marker={m}
        pps={pps}
        labelWidth={Math.min(160, next ? (next.time - m.time) * pps - 12 : 160)}
        renaming={renaming === m.id}
        setRenaming={setRenaming}
        focusNextRef={focusNextRef}
        neighbor={(next ?? sorted[i - 1])?.id ?? null}
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
  focusNextRef,
  neighbor,
}: {
  marker: Marker
  pps: number
  labelWidth: number
  renaming: boolean
  setRenaming: (id: string | null) => void
  focusNextRef: { current: string | null }
  neighbor: string | null
}) {
  const goTo = () => set({ playhead: marker.time, playing: false })
  const time = formatTime(marker.time, true)
  // Set by Remove marker in the menu, so the closing menu hands focus on instead of dropping it on the page.
  const removedFromMenu = useRef(false)
  const remove = () => {
    focusNextRef.current = neighbor
    removeMarker(marker.id)
    if (!neighbor && !removedFromMenu.current) focusAddMarker()
  }

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
      moveMarker(marker.id, snapMarkerTime(t0 + (ev.clientX - x0) / get().pxPerSec), true)
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
    else if (e.key === 'Delete' || e.key === 'Backspace') remove()
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      nudgeMarker(marker.id, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1))
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
          if (e.key === 'Enter' || e.key === 'Escape') {
            focusNextRef.current = marker.id
            e.currentTarget.blur()
          }
          e.stopPropagation()
        }}
      />
    )

  return (
    <ContextMenu>
      <Tooltip label={`${marker.label} · ${time}`} description="Drag to move · Double-click to rename">
        <ContextMenuTrigger asChild>
          <button
            ref={(el) => {
              if (el && focusNextRef.current === marker.id) {
                focusNextRef.current = null
                el.focus()
              }
            }}
            className={styles.marker}
            style={style}
            aria-label={`${marker.label}, marker at ${time}`}
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
      </Tooltip>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (!removedFromMenu.current) return
          removedFromMenu.current = false
          e.preventDefault()
          if (!neighbor) focusAddMarker()
        }}
      >
        <ContextMenuItem shortcut="Enter" onSelect={goTo}>
          Go to marker
        </ContextMenuItem>
        <ContextMenuItem shortcut="F2" onSelect={() => setRenaming(marker.id)}>
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          danger
          shortcut="Delete"
          onSelect={() => {
            removedFromMenu.current = true
            remove()
          }}
        >
          Remove marker
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
