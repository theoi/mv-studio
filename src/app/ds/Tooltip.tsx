import { Tooltip as RTooltip } from 'radix-ui'
import type { ReactNode } from 'react'
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

export function Tooltip({ label, shortcut, description, side = 'bottom', children }: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
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
