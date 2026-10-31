import { Popover as RPopover } from 'radix-ui'
import type { ReactNode } from 'react'
import styles from './Popover.module.css'

export const Popover = RPopover.Root
export const PopoverTrigger = RPopover.Trigger

/**
 * A small panel of controls that opens from its trigger. Focus moves into it; Escape or a click outside closes it and
 * returns focus to the trigger.
 */
export function PopoverContent({
  title,
  children,
  side = 'bottom',
  align = 'center',
}: {
  title: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        className={styles.content}
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
        aria-label={title}
      >
        <div className={styles.title}>{title}</div>
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  )
}
