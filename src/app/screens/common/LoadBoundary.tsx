import { Component, type ReactNode } from 'react'
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
  return (
    <div className="screen-error" role="alert">
      <EmptyState
        icon={<WifiOff />}
        title={vj ? 'VJ mode couldn’t load' : 'This screen couldn’t load'}
        description={
          screen === 'setup'
            ? 'Check your connection and try again.'
            : 'Check your connection and try again. Your project is saved.'
        }
        action={
          <>
            <Button variant="primary" size="sm" onClick={retry}>
              Try again
            </Button>
            {vj ? (
              <Button size="sm" onClick={leaveVj}>
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
