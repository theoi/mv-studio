import type { ReactNode } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { usePrefs } from '../../state/prefs.ts'
import { set, useUi } from '../../state/ui.ts'
import styles from './Suggestion.module.css'

interface Props {
  id: string
  children: ReactNode
  action: string
  onAction: () => void
  variant?: 'card' | 'chip'
}

/** The single inline-suggestion pattern: quiet, in context, one click to apply, dismissible. */
export function InlineSuggestion({ id, children, action, onAction, variant = 'card' }: Props) {
  const dismissed = useUi((s) => s.dismissed.includes(id))
  const on = usePrefs((p) => p.suggestions)
  if (dismissed || !on) return null
  const dismiss = () => set((s) => ({ dismissed: [...s.dismissed, id] }))
  if (variant === 'chip') {
    return (
      <div className={styles.chip} role="note">
        <Sparkles className={styles.icon} />
        <span className={styles.chipText}>{children}</span>
        <button className={styles.chipAction} onClick={onAction}>
          {action}
        </button>
        <button className={styles.close} aria-label="Dismiss suggestion" onClick={dismiss}>
          <X />
        </button>
      </div>
    )
  }
  return (
    <div className={styles.card} role="note">
      <Sparkles className={styles.icon} />
      <div className={styles.body}>
        <div className={styles.text}>{children}</div>
        <div className={styles.actions}>
          <Button size="sm" variant="subtle" onClick={onAction}>
            {action}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  )
}
