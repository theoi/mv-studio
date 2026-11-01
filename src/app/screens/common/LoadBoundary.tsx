import { Component, useEffect, useRef, type ReactNode } from 'react'
import { WifiOff } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { EmptyState } from '../../ds/Feedback.tsx'
import { LoadError, retryFailedLoads } from '../../lazy.ts'
import { set, type Screen } from '../../state/ui.ts'
import { leaveVj } from '../../state/vj.ts'

interface Props {
  children: ReactNode
  /** Shown instead of the children once their code failed to load; `retry` loads it again. */
  fallback: (retry: () => void) => ReactNode
  onError?: () => void
}

/** Catches code that failed to load below it (LoadError from ../../lazy.ts); other errors pass on. */
export class LoadBoundary extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  override componentDidCatch(error: unknown) {
    if (error instanceof LoadError) this.props.onError?.()
  }

  retry = () => {
    retryFailedLoads()
    this.setState({ error: null })
  }

  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    if (!(error instanceof LoadError)) throw error
    return this.props.fallback(this.retry)
  }
}

/** In place of a screen whose code failed to load: try again, or go somewhere that has loaded. */
export function ScreenLoadFailed({ screen, retry }: { screen: Screen; retry: () => void }) {
  const vj = screen === 'vj'
  const tryAgain = useRef<HTMLButtonElement>(null)
  // Also after a failed Try again, which unmounts the card while the code loads: focus would be left on the page.
  useEffect(() => tryAgain.current?.focus(), [])
  useEffect(() => {
    if (!vj) return
    // As everywhere else in VJ mode, Esc goes back to the editor.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) leaveVj()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vj])
  return (
    <div className="screen-error" role="alert">
      <EmptyState
        icon={<WifiOff />}
        title={vj ? 'VJ mode couldn’t load' : 'This screen couldn’t load'}
        description={
          screen === 'setup'
            ? 'Check your connection and try again.'
            : // Non-breaking spaces keep the second sentence on one line.
              'Check your connection and try again. Your\u00a0project\u00a0is\u00a0saved.'
        }
        action={
          <>
            <Button ref={tryAgain} variant="primary" size="sm" onClick={retry}>
              Try again
            </Button>
            {vj ? (
              <Button size="sm" onClick={() => leaveVj()}>
                Back to editor
              </Button>
            ) : (
              <Button size="sm" onClick={() => set({ screen: 'start', dialog: null })}>
                Home
              </Button>
            )}
          </>
        }
      />
    </div>
  )
}
