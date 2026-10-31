import { useEffect, useRef, type RefObject } from 'react'
import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { JOB_KINDS, latestJob, useJobs } from '../../../state/jobs.ts'
import { useProject } from '../../../state/project.ts'
import { songState, useSongPending, type SongState } from '../../../state/songAnalysis.ts'
import { set, useUi } from '../../../state/ui.ts'

export type Phase = 'idle' | 'running' | 'done' | 'failed'

/** Latest job of a kind and the state its tool view shows. A dismissed result returns the view to idle. */
export function useJob(kind: string): { job?: JobSnapshot; phase: Phase } {
  const job = latestJob(useJobs(), kind)
  const dismissed = useUi((s) => s.dismissed)
  if (!job || dismissed.includes(job.id)) return { phase: 'idle' }
  if (job.status === 'queued' || job.status === 'running') return { job, phase: 'running' }
  if (job.status === 'succeeded') return { job, phase: 'done' }
  if (job.status === 'failed') return { job, phase: 'failed' }
  return { phase: 'idle' }
}

/** Where the song's analysis stands (`songState`), from the latest analysis job. */
export function useSongState(): SongState {
  const project = useProject()
  const { phase } = useJob(JOB_KINDS.analysis)
  return songState(project, phase, useSongPending(project.songAssetId))
}

/**
 * Keeps focus in a tool after its Cancel. The running view goes away when the run ends, which drops focus to the
 * page: it goes to the next view's main action (`target`) instead, unless something else took it meanwhile. When the
 * next view has a `note` about the stop, both are scrolled into view if they fit together. Pass `cancelled` as the
 * CancelButton's `onCancel`.
 */
export function useFocusAfterCancel(running: boolean, note?: RefObject<HTMLElement | null>) {
  const pending = useRef(false)
  const target = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  useEffect(() => {
    const ended = wasRunning.current && !running
    wasRunning.current = running
    if (!ended || !pending.current) return
    pending.current = false
    const button = target.current
    if (button && (!document.activeElement || document.activeElement === document.body))
      focusShowing(button, note?.current ?? null)
  }, [running, note])
  const cancelled = () => {
    pending.current = true
  }
  return { cancelled, target }
}

/**
 * The scroll position that brings the span from `top` to `bottom` (in the scroller's content) into a view of
 * `height` with the least scrolling, or null when the span is taller than the view.
 */
export function scrollToShow(scrollTop: number, height: number, top: number, bottom: number): number | null {
  if (bottom - top > height) return null
  if (top < scrollTop) return top
  if (bottom > scrollTop + height) return bottom - height
  return scrollTop
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/** Focuses `button` and shows `note` with it when both fit in their scroller; else shows just the button. */
function focusShowing(button: HTMLElement, note: HTMLElement | null) {
  const scroller = note && scrollerOf(button)
  if (!note || !scroller?.contains(note)) {
    button.focus()
    return
  }
  button.focus({ preventScroll: true })
  const view = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop
  const n = note.getBoundingClientRect()
  const b = button.getBoundingClientRect()
  const top = scrollToShow(
    scroller.scrollTop,
    scroller.clientHeight,
    Math.min(n.top, b.top) - view,
    Math.max(n.bottom, b.bottom) - view,
  )
  if (top === null) button.scrollIntoView({ block: 'nearest' })
  else scroller.scrollTop = top
}

/** Returns a finished or failed tool view to idle. */
export function dismiss(job?: JobSnapshot) {
  if (job) set((s) => ({ dismissed: [...s.dismissed, job.id] }))
}

export const pct = (job?: JobSnapshot) => Math.round((job?.progress.fraction ?? 0) * 100)

export function etaText(job?: JobSnapshot): string | undefined {
  const s = job?.progress.etaSeconds
  if (s === undefined) return undefined
  if (s < 50) return 'Less than a minute left'
  return `About ${Math.round(s / 60)} min left`
}
