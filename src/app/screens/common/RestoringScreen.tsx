import { useEffect, useState } from 'react'
import { Spinner } from '../../ds/Feedback.tsx'
import { usePersistence } from '../../state/persistence.ts'
import styles from './Common.module.css'

/** Most restores finish well within this, and their screen stays blank; a slower one then says what it is opening. */
const NOTE_AFTER_MS = 1000

/** In place of the editor or VJ mode while the project a link or the last visit names is loading. */
export function RestoringScreen() {
  const [slow, setSlow] = useState(false)
  // The kept projects are listed alongside, so the name may arrive after the note does.
  const name = usePersistence((s) => s.recents?.find((r) => r.id === s.restoringId)?.name)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), NOTE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div className={`screen-loading ${styles.restoring}`}>
      {/* The live region is there from the start, so the note is announced when it appears. */}
      <p className={styles.restoringStatus} role="status">
        {slow && (
          <span className={styles.restoringNote}>
            <Spinner />
            <span className={styles.restoringText}>
              {name ? `Opening “${name}”…` : 'Opening the project…'}
            </span>
          </span>
        )}
      </p>
    </div>
  )
}
