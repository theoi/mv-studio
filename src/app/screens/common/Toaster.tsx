import { X } from 'lucide-react'
import { set, useUi } from '../../state/ui.ts'
import styles from './Common.module.css'

export function Toaster() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className={styles.toaster} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast} data-toast>
          <span>{t.message}</span>
          {t.show && (
            <button className={styles.toastAction} onClick={t.show}>
              Show
            </button>
          )}
          {t.action && (
            <button
              className={styles.toastAction}
              onClick={() => {
                t.action!.run()
                set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            className={styles.toastClose}
            aria-label="Dismiss"
            onClick={() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}
