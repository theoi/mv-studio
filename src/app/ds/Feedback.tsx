import type { ReactNode } from 'react'
import styles from './Feedback.module.css'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export function Badge({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: Tone
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <span className={[styles.badge, styles[`badge-${tone}`]].join(' ')}>
      {icon}
      {children}
    </span>
  )
}

export function ProgressBar({
  value,
  tone = 'accent',
  label,
}: {
  value: number
  tone?: 'accent' | 'success'
  label?: string
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div
        className={[styles.progressFill, tone === 'success' && styles.progressSuccess]
          .filter(Boolean)
          .join(' ')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function ProgressRing({ value, size = 16, label }: { value: number; size?: number; label?: string }) {
  const r = size / 2 - 2
  const c = 2 * Math.PI * r
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={styles.ring}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
    >
      <circle cx={size / 2} cy={size / 2} r={r} className={styles.ringTrack} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className={styles.ringFill}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className={styles.spinner} style={{ width: size, height: size }} aria-hidden />
}

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
}

export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <div className={[styles.empty, compact && styles.emptyCompact].filter(Boolean).join(' ')}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      <div className={styles.emptyTitle}>{title}</div>
      {description && <div className={styles.emptyDesc}>{description}</div>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  )
}
