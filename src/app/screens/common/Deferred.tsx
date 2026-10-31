import { Suspense, useState, type ReactNode } from 'react'
import { retryFailedLoads } from '../../lazy.ts'
import { toast } from '../../state/ui.ts'
import { LoadBoundary } from './LoadBoundary.tsx'

interface Props {
  when: boolean
  /** What the toast calls the dialog when its code fails to load ("Export couldn’t load…"). */
  name: string
  /** Turns `when` off: a dialog whose code failed to load closes, so opening it again tries again. */
  close: () => void
  children: ReactNode
}

/** Mounts its (lazy) children the first time `when` is true and keeps them mounted, so dialogs keep their state. */
export function Deferred({ when, name, close, children }: Props) {
  const [seen, setSeen] = useState(when)
  // Set when the code failed to load; cleared once `when` turns off, so a failure is not retried in a loop.
  const [failed, setFailed] = useState(false)
  if (when && !seen && !failed) setSeen(true)
  if (!when && failed) setFailed(false)
  if (!seen) return null
  return (
    <LoadBoundary
      fallback={() => null}
      onError={() => {
        toast(`${name} couldn’t load. Check your connection and try again.`)
        setFailed(true)
        setSeen(false)
        close()
        retryFailedLoads()
      }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </LoadBoundary>
  )
}
