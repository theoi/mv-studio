import { Suspense, useState, type ReactNode } from 'react'
import { retryFailedLoads } from '../../lazy.ts'
import { LoadBoundary } from './LoadBoundary.tsx'

interface Props {
  when: boolean
  /** The children's code failed to load: say so if right, and turn `when` off, so opening them again tries again. */
  onFail: () => void
  children: ReactNode
}

/** Mounts its (lazy) children the first time `when` is true and keeps them mounted, so dialogs keep their state. */
export function Deferred({ when, onFail, children }: Props) {
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
        setFailed(true)
        setSeen(false)
        onFail()
        retryFailedLoads()
      }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </LoadBoundary>
  )
}
