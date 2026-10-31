import { Tabs as RTabs } from 'radix-ui'
import type { ReactNode } from 'react'
import styles from './Tabs.module.css'

export const Tabs = RTabs.Root
export const TabsContent = RTabs.Content

export function TabsList({
  children,
  variant = 'underline',
  ariaLabel,
}: {
  children: ReactNode
  variant?: 'underline' | 'pill'
  ariaLabel: string
}) {
  return (
    <RTabs.List className={[styles.list, styles[variant]].join(' ')} aria-label={ariaLabel}>
      {children}
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
