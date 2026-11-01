import { useEffect, useRef } from 'react'
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
 * Keeps focus in a tool through a run started or stopped from a button that the run's views replace: a Cancel, or a
 * redraft. When the run ends, focus would drop to the page: it goes to the next view's main action (`target`, in the
 * tool's footer) instead, unless something else took it meanwhile. Call `keep` from that button's handler.
 */
export function useKeepFocus(running: boolean) {
  const pending = useRef(false)
  const target = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  useEffect(() => {
    const ended = wasRunning.current && !running
    wasRunning.current = running
    if (!ended || !pending.current) return
    pending.current = false
    const button = target.current
    if (!button || (document.activeElement && document.activeElement !== document.body)) return
    button.focus({ preventScroll: true })
    // Scrolling just the button into view leaves it under the fade that says more is below, with the rest of the
    // footer (the note about the stop, say) out of view. The whole footer ends the scroll in a short panel.
    const footer = button.closest<HTMLElement>('[data-tool-footer]') ?? button
    footer.scrollIntoView({ block: 'nearest' })
  }, [running])
  const keep = () => {
    pending.current = true
  }
  return { keep, target }
}

/** Returns a finished or failed tool view to idle. */
export function dismiss(job?: JobSnapshot) {
  if (job) set((s) => ({ dismissed: [...s.dismissed, job.id] }))
}

export const pct = (job?: JobSnapshot) => Math.round((job?.progress.fraction ?? 0) * 100)

/**
 * How far the model download a job shows as its line has got, in percent, rather than the job: undefined while the
 * job shows no download.
 */
export function downloadPct(job?: JobSnapshot): number | undefined {
  const p = job?.progress
  if (p?.stage !== 'download' || !p.bytesTotal) return undefined
  return Math.round(Math.min(1, (p.bytesLoaded ?? 0) / p.bytesTotal) * 100)
}

export function etaText(job?: JobSnapshot): string | undefined {
  const s = job?.progress.etaSeconds
  if (s === undefined) return undefined
  if (s < 50) return 'Less than a minute left'
  return `About ${Math.round(s / 60)} min left`
}
