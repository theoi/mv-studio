import { Tabs as RTabs } from 'radix-ui'
import type { ReactNode } from 'react'
import styles from './Tabs.module.css'

export const Tabs = RTabs.Root
export const TabsContent = RTabs.Content

export function TabsList({
  children,
  variant = 'underline',
  ariaLabel,
  trailing,
}: {
  children: ReactNode
  variant?: 'underline' | 'pill'
  ariaLabel: string
  /** Controls at the end of the tab row, such as a collapse button. */
  trailing?: ReactNode
}) {
  return (
    <RTabs.List className={[styles.list, styles[variant]].join(' ')} aria-label={ariaLabel}>
      {children}
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </RTabs.List>
  )
}

export function TabsTrigger({
  value,
  children,
  icon,
  trailing,
}: {
  value: string
  children: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <RTabs.Trigger value={value} className={styles.trigger}>
      {icon}
      <span>{children}</span>
      {trailing}
    </RTabs.Trigger>
  )
}
