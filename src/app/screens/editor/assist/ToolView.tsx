import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, X } from 'lucide-react'
import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { jobs } from '../../../../shared/jobs.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { ProgressBar, Spinner } from '../../../ds/Feedback.tsx'
import { openAssist } from '../../../state/ui.ts'
import { etaText, pct } from './jobState.ts'
import styles from './Assist.module.css'

/** The frame of every Assist tool: back to all tools, title, scrolling body and a pinned footer for the action. */
export function ToolView({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className={styles.view}>
      <div className={styles.viewHeader}>
        <IconButton label="All tools" size="sm" onClick={() => openAssist('home')} tooltipSide="bottom">
          <ArrowLeft />
        </IconButton>
        <div className={styles.viewTitles}>
          <div className={styles.viewTitle}>{title}</div>
          {subtitle && <div className={styles.viewSub}>{subtitle}</div>}
        </div>
      </div>
      <div className={`${styles.viewBody} scroll`}>{children}</div>
      {footer && <div className={styles.viewFooter}>{footer}</div>}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldLabel}>{label}</div>
      {children}
      {hint && <div className={styles.fieldHint}>{hint}</div>}
    </div>
  )
}

export function Steps({ steps, active }: { steps: string[]; active: number }) {
  return (
    <ol className={styles.steps}>
      {steps.map((s, i) => (
        <li key={s} className={i < active ? styles.stepDone : i === active ? styles.stepActive : undefined}>
          <span className={styles.stepMark}>
            {i < active ? <Check /> : i === active ? <Spinner size={11} /> : null}
          </span>
          {s}
        </li>
      ))}
    </ol>
  )
}

export function RunCard({ job, label }: { job?: JobSnapshot; label: string }) {
  return (
    <div className={styles.runCard}>
      <div className={styles.jobTop}>
        <span>{job?.progress.message ?? label}</span>
        <span className={`${styles.jobPct} tnum`}>{pct(job)}%</span>
      </div>
      <ProgressBar value={job?.progress.fraction ?? 0} label={label} />
      {etaText(job) && <div className={styles.jobEta}>{etaText(job)}</div>}
    </div>
  )
}

/** Cancels a running job: full width in a panel footer, or `inline` at the end of a progress row. */
export function CancelButton({ job, inline = false }: { job?: JobSnapshot; inline?: boolean }) {
  return (
    <Button
      variant={inline ? 'ghost' : 'secondary'}
      size={inline ? 'sm' : 'md'}
      block={!inline}
      icon={<X />}
      onClick={() => job && jobs.cancel(job.id)}
    >
      Cancel
    </Button>
  )
}

/** "1:12" since `since`, ticking every second. Hidden from screen readers, which would hear every tick. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const s = Math.max(0, Math.round((now - since) / 1000))
  return <span aria-hidden="true">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>
}
