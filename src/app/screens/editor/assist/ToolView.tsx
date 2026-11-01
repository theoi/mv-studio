import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowLeft, Check, X } from 'lucide-react'
import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { jobs } from '../../../../shared/jobs.ts'
import { Button, IconButton } from '../../../ds/Button.tsx'
import { ProgressBar, Spinner } from '../../../ds/Feedback.tsx'
import { jobFraction } from '../../../state/jobs.ts'
import { openAssist } from '../../../state/ui.ts'
import { etaText, jobLine, pct } from './jobState.ts'
import styles from './Assist.module.css'

/**
 * The most of the scrolling area a pinned footer may take in a short view; a taller one ends the scroll instead. At
 * 1280×720 every tool's footer stays pinned, unless a note above its button makes it taller.
 */
const MAX_PINNED_SHARE = 1 / 3
/** A view at least this tall keeps any footer pinned (the compact footer's container query uses it too). */
const SHORT_VIEW = 480

/** Marks the scroller (`data-footer-scrolls`) when its footer is too tall to stay pinned, unless it is `pinned`. */
function markFooterScrolls(area: HTMLElement | null, bar: HTMLElement | null, pinned: boolean) {
  const view = area?.parentElement
  area?.toggleAttribute(
    'data-footer-scrolls',
    !pinned &&
      !!bar &&
      !!view &&
      view.clientHeight <= SHORT_VIEW &&
      bar.offsetHeight > area.clientHeight * MAX_PINNED_SHARE,
  )
}

/**
 * Lets a tall footer end the scroll instead of staying pinned: pinned, it would leave a short panel little room for
 * the body, so there the body comes first and a fade says more is below. `pinned` keeps the footer in view whatever
 * its height. Set on the element during layout, not through state: a tool that moves focus into its new footer after a
 * render (useKeepFocus) must scroll with the footer already in its place.
 */
function useFooterScrolls(
  scroll: RefObject<HTMLElement | null>,
  footer: RefObject<HTMLElement | null>,
  pinned: boolean,
  hasFooter: boolean,
) {
  // Every render: what the footer holds changes with the tool's state.
  useLayoutEffect(() => markFooterScrolls(scroll.current, footer.current, pinned))
  useLayoutEffect(() => {
    if (!hasFooter) return
    const observer = new ResizeObserver(() => markFooterScrolls(scroll.current, footer.current, pinned))
    if (scroll.current) observer.observe(scroll.current)
    if (footer.current) observer.observe(footer.current)
    return () => observer.disconnect()
  }, [scroll, footer, pinned, hasFooter])
}

/**
 * The frame of every Assist tool: back to all tools, title, scrolling body and a pinned footer for the action. In a
 * short panel a tall footer ends the scroll instead, unless `pinFooter` keeps it in view (a Cancel while a paid run
 * goes on).
 */
export function ToolView({
  title,
  subtitle,
  children,
  footer,
  pinFooter = false,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  pinFooter?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  useFooterScrolls(scrollRef, footerRef, pinFooter, Boolean(footer))
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
      <div ref={scrollRef} className={`${styles.viewScroll} scroll`}>
        <div className={styles.viewBody}>{children}</div>
        {footer && (
          <div ref={footerRef} className={styles.viewFooter} data-tool-footer>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
  hintId,
  action,
}: {
  label: string
  children: ReactNode
  hint?: string
  /** Id for the hint, so the control can point to it with aria-describedby. */
  hintId?: string
  /** A small button at the label's right end, such as a reset. */
  action?: ReactNode
}) {
  return (
    <div className={styles.field}>
      <div className={action ? styles.fieldLabelRow : styles.fieldLabel}>
        {action ? <span className={styles.fieldLabel}>{label}</span> : label}
        {action}
      </div>
      {children}
      {hint && (
        <div className={styles.fieldHint} id={hintId}>
          {hint}
        </div>
      )}
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

/**
 * A job's step and progress. `placeholder` names the first step until the job reports one (`label` names the bar).
 * `note` goes on the line under the bar while there is no time left to show there. After a Cancel, until the job
 * ends, the step says "Stopping…" and a spinner takes the percentage's place, as in the top bar. While the step is a
 * model downloading, the step says how far the download is, and the percentage stays the job's, as the bar does.
 */
export function RunCard({
  job,
  label,
  placeholder,
  note,
}: {
  job?: JobSnapshot
  label: string
  placeholder?: string
  note?: string
}) {
  const below = etaText(job) ?? note
  return (
    <div className={styles.runCard}>
      <div className={styles.jobTop}>
        <span>{job?.stopping ? 'Stopping…' : (jobLine(job) ?? placeholder ?? label)}</span>
        {job && jobFraction(job) === undefined ? (
          <Spinner size={12} />
        ) : (
          <span className={`${styles.jobPct} tnum`}>{pct(job)}%</span>
        )}
      </div>
      <ProgressBar value={job?.progress.fraction ?? 0} label={label} />
      {below && <div className={styles.jobEta}>{below}</div>}
    </div>
  )
}

/** Cancels a running job: full width in a panel footer, or `inline` at the end of a progress row. */
export function CancelButton({
  job,
  inline = false,
  onCancel,
  disabled = false,
}: {
  job?: JobSnapshot
  inline?: boolean
  /** After the cancel is requested, e.g. to move focus off the button before it goes away. */
  onCancel?: () => void
  /**
   * For a job that took the cancel but is still finishing (it stops on its own). The button stays focusable
   * (aria-disabled), so a keyboard Cancel doesn't drop focus to the page.
   */
  disabled?: boolean
}) {
  return (
    <Button
      variant={inline ? 'ghost' : 'secondary'}
      size={inline ? 'sm' : 'md'}
      block={!inline}
      icon={<X />}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        if (job) jobs.cancel(job.id)
        onCancel?.()
      }}
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
