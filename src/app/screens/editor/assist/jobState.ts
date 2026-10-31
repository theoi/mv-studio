import type { JobSnapshot } from '../../../../shared/jobs.ts'
import { latestJob, useJobs } from '../../../state/jobs.ts'
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
