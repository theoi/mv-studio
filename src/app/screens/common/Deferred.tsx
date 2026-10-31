import { Suspense, useState, type ReactNode } from 'react'

/** Mounts its (lazy) children the first time `when` is true and keeps them mounted, so dialogs keep their state. */
export function Deferred({ when, children }: { when: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(when)
  if (when && !seen) setSeen(true)
  return seen ? <Suspense fallback={null}>{children}</Suspense> : null
}
