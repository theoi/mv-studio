import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { editor } from '../../state/project.ts'
import {
  dismissToast,
  holdToast,
  releaseToast,
  useUi,
  withdrawUndoOnChange,
  type Toast,
} from '../../state/ui.ts'
import styles from './Common.module.css'

export function Toaster() {
  const toasts = useUi((s) => s.toasts)
  useEffect(() => withdrawUndoOnChange(editor), [])
  return (
    <div className={styles.toaster} role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}

/** Stays open while the pointer is on it or focus is in it, then gets its full time again. */
function ToastItem({ toast: t }: { toast: Toast }) {
  const pointer = useRef(false)
  const focus = useRef(false)
  // Where focus was before it came into the toast: closing the toast under it would otherwise drop it on the body.
  const returnTo = useRef<HTMLElement | null>(null)
  const sync = () => (pointer.current || focus.current ? holdToast(t.id) : releaseToast(t.id))
  const close = () => {
    const back = focus.current ? returnTo.current : null
    dismissToast(t.id)
    if (back?.isConnected) back.focus()
  }
  return (
    <div
      className={styles.toast}
      data-toast
      onPointerEnter={() => {
        pointer.current = true
        sync()
      }}
      onPointerLeave={() => {
        pointer.current = false
        sync()
      }}
      onFocus={(e) => {
        if (!focus.current) returnTo.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null
        focus.current = true
        sync()
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        focus.current = false
        sync()
      }}
    >
      <span>{t.message}</span>
      {t.show && (
        <button
          className={styles.toastAction}
          onClick={() => {
            t.show!()
            sync()
          }}
        >
          Show
        </button>
      )}
      {t.action && (
        <button
          className={styles.toastAction}
          onClick={() => {
            t.action!.run()
            close()
          }}
        >
          {t.action.label}
        </button>
      )}
      <button className={styles.toastClose} aria-label="Dismiss" onClick={close}>
        <X />
      </button>
    </div>
  )
}
