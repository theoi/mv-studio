import { useSyncExternalStore } from 'react'
import { JobError, jobs, type JobErrorCode, type JobSnapshot } from '../../shared/jobs.ts'

export function useJobs(): JobSnapshot[] {
  return useSyncExternalStore(
    (l) => jobs.subscribe(l),
    () => jobs.list(),
  )
}

/** Most recent job of a kind, so a tool view can show idle, running, done or failed. */
export function latestJob(list: JobSnapshot[], kind: string): JobSnapshot | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.kind === kind) return list[i]
  return undefined
}

export function runningJobs(list: JobSnapshot[]): JobSnapshot[] {
  return list.filter((j) => j.status === 'running' || j.status === 'queued')
}

export function isRunning(kind: string): boolean {
  return runningJobs(jobs.list()).some((j) => j.kind === kind)
}

export const JOB_KINDS = {
  stems: 'analysis.stems',
  director: 'director.plan',
  directorShots: 'director.generate',
  ask: 'director.ask',
  autocut: 'edit.autocut',
  camera: 'vision.camera',
  cutout: 'vision.cutout',
  suitability: 'vision.suitability',
  export: 'export.outputs',
  footage: 'vision.index',
  lyrics: 'analysis.lyrics',
  generate: 'cloud.generate',
  realign: 'analysis.realign',
} as const

interface MockJobOptions {
  kind: string
  title: string
  seconds: number
  startAt?: number
  stages?: { at: number; stage: string; message: string }[]
  fail?: { at: number; code: JobErrorCode; message: string }
  onDone?: () => void
}

/**
 * Stand-in for real feature jobs in the design preview: runs on the shared JobRunner with the same progress,
 * cancel and typed-error behavior, so the UI is already wired to the real contract.
 */
export function runMockJob(o: MockJobOptions) {
  const handle = jobs.run({
    kind: o.kind,
    title: o.title,
    run: (ctx) =>
      new Promise<void>((resolve, reject) => {
        let f = o.startAt ?? 0
        const step = 0.1 / o.seconds
        const tick = () => {
          if (ctx.signal.aborted) {
            clearInterval(id)
            reject(new JobError('cancelled', 'Cancelled'))
            return
          }
          f = Math.min(1, f + step)
          if (o.fail && f >= o.fail.at) {
            clearInterval(id)
            reject(new JobError(o.fail.code, o.fail.message, { retryable: true }))
            return
          }
          const stage = [...(o.stages ?? [])].reverse().find((s) => f >= s.at)
          ctx.progress({
            fraction: f,
            stage: stage?.stage,
            message: stage?.message,
            etaSeconds: (1 - f) * o.seconds,
          })
          if (f >= 1) {
            clearInterval(id)
            resolve()
          }
        }
        const id = setInterval(tick, 100)
        tick()
      }),
  })
  if (o.onDone) handle.promise.then(o.onDone, () => undefined)
  return handle
}
