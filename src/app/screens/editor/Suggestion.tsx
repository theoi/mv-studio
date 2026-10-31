import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '../../ds/Button.tsx'
import { usePrefs } from '../../state/prefs.ts'
import { hasSuggestionTurn, joinSuggestionQueue, useSuggestionQueue } from '../../state/suggestions.ts'
import { set, useUi } from '../../state/ui.ts'
import styles from './Suggestion.module.css'

interface Props {
  id: string
  children: ReactNode
  action: string
  onAction: () => void
  variant?: 'card' | 'chip'
  /** A standing hint, not about the selection: it gives way to a suggestion about what is selected. */
  ambient?: boolean
}

/** Whether this suggestion is the one on screen; it waits in line while `wants` and another one shows. */
function useTurn(wants: boolean, ambient: boolean): boolean {
  const key = useId()
  // A layout effect, so a suggestion that gets the turn appears in the same frame instead of flashing in after it.
  useLayoutEffect(() => (wants ? joinSuggestionQueue(key, ambient) : undefined), [key, wants, ambient])
  return useSuggestionQueue((s) => hasSuggestionTurn(key, s.waiting))
}

const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Focuses the control Tab would reach after `el` in its panel, else the one before it. */
function focusPast(el: HTMLElement) {
  const scope = el.closest('[role="tabpanel"]') ?? document.body
  const controls = [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (c) => !el.contains(c) && c.checkVisibility(),
  )
  const after = controls.find((c) => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
  const before = controls.findLast((c) => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING)
  const target = after ?? before
  target?.focus()
}

/** The single inline-suggestion pattern: quiet, in context, one click to apply, dismissible, one at a time. */
export function InlineSuggestion({
  id,
  children,
  action,
  onAction,
  variant = 'card',
  ambient = false,
}: Props) {
  const dismissed = useUi((s) => s.dismissed.includes(id))
  const on = usePrefs((p) => p.suggestions)
  const turn = useTurn(on && !dismissed, ambient)
  const root = useRef<HTMLDivElement>(null)
  if (dismissed || !on || !turn) return null
  const dismiss = () => {
    // Dismissing unmounts the suggestion under the focused button, which would drop focus to the page.
    if (root.current?.contains(document.activeElement)) focusPast(root.current)
    set((s) => ({ dismissed: [...s.dismissed, id] }))
  }
  if (variant === 'chip') {
    return (
      <div ref={root} className={styles.chip} role="note">
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
    <div ref={root} className={styles.card} role="note">
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
