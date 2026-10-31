import { Tooltip as RTooltip } from 'radix-ui'
import type { FocusEvent, ReactNode } from 'react'
import { Kbd } from './Kbd.tsx'
import styles from './Feedback.module.css'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={450} skipDelayDuration={250}>
      {children}
    </RTooltip.Provider>
  )
}

interface TooltipProps {
  label: ReactNode
  shortcut?: string
  description?: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}

/**
 * A focus that draws no ring (focus put back on the trigger after a click elsewhere) opens no tooltip: it would stay
 * open over the page until the next click. Radix skips opening when the focus event's default is prevented.
 */
function onlyKeyboardFocus(e: FocusEvent<HTMLElement>) {
  if (!e.currentTarget.matches(':focus-visible')) e.preventDefault()
}

export function Tooltip({ label, shortcut, description, side = 'bottom', children }: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild onFocus={onlyKeyboardFocus}>
        {children}
      </RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} collisionPadding={8} className={styles.tooltip}>
          <span className={styles.tooltipRow}>
            <span>{label}</span>
            {shortcut && <Kbd keys={shortcut} />}
          </span>
          {description && <span className={styles.tooltipDesc}>{description}</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
