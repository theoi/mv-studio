import { useSyncExternalStore } from 'react'
import { JobError, jobs, type JobErrorCode, type JobSnapshot } from '../../shared/jobs.ts'
import { openAssist, set, type AssistView } from './ui.ts'

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

/** Every kind of job the app runs or follows. Each needs an entry in JOB_TARGETS, which the type checker enforces. */
export const JOB_KINDS = {
  stems: 'analysis.stems',
  director: 'director.plan',
  autocut: 'edit.autocut',
  camera: 'vision.camera',
  cutout: 'vision.cutout',
  suitability: 'vision.suitability',
  export: 'export.outputs',
  footage: 'vision.index',
  lyrics: 'analysis.lyrics',
  generate: 'cloud.generate',
  realign: 'analysis.realign',
  analysis: 'analysis.song',
  downbeats: 'analysis.downbeats',
  directorShots: 'director.generate',
  ask: 'director.ask',
  import: 'media.import',
  projectImport: 'project.import',
  projectExport: 'project.export',
} as const

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS]

/** What clicking a running job opens: the Assist view that follows it, the export dialog, the media library, or nothing. */
export type JobTarget =
  { type: 'assist'; view: AssistView } | { type: 'export' } | { type: 'media' } | { type: 'none' }

const assist = (view: AssistView): JobTarget => ({ type: 'assist', view })

const JOB_TARGETS: Record<JobKind, JobTarget> = {
  [JOB_KINDS.stems]: assist('stems'),
  [JOB_KINDS.director]: assist('director'),
  [JOB_KINDS.directorShots]: assist('director'),
  // The Ask box on Assist's home shows its own progress.
  [JOB_KINDS.ask]: assist('home'),
  [JOB_KINDS.autocut]: assist('autocut'),
  [JOB_KINDS.camera]: assist('camera'),
  [JOB_KINDS.cutout]: assist('behind'),
  [JOB_KINDS.suitability]: assist('behind'),
  [JOB_KINDS.lyrics]: assist('lyrics'),
  [JOB_KINDS.realign]: assist('lyrics'),
  [JOB_KINDS.analysis]: assist('analysis'),
  [JOB_KINDS.downbeats]: assist('analysis'),
  [JOB_KINDS.generate]: assist('generate'),
  [JOB_KINDS.export]: { type: 'export' },
  [JOB_KINDS.footage]: { type: 'media' },
  [JOB_KINDS.import]: { type: 'media' },
  // Opening a project file replaces the editor and saving one downloads it: nothing shows them while they run.
  [JOB_KINDS.projectImport]: { type: 'none' },
  [JOB_KINDS.projectExport]: { type: 'none' },
}

const isJobKind = (kind: string): kind is JobKind => Object.hasOwn(JOB_TARGETS, kind)

/**
 * Where a job of `kind` opens. A kind with a detail suffix ('cloud.generate.image') follows its base kind, and a kind
 * the app doesn't know opens Assist's home, which lists what is running, never an unrelated dialog.
 */
export function jobTarget(kind: string): JobTarget {
  if (isJobKind(kind)) return JOB_TARGETS[kind]
  const base = Object.values(JOB_KINDS).find((k) => kind.startsWith(`${k}.`))
  return base ? JOB_TARGETS[base] : assist('home')
}

/** Opens what follows a running job: its Assist view, the export dialog or the media library. */
export function openJob(kind: string): void {
  const target = jobTarget(kind)
  if (target.type === 'assist') openAssist(target.view)
  else if (target.type === 'export') set({ dialog: 'export', exportPhase: 'exporting' })
  else if (target.type === 'media') set({ libraryOpen: true, libraryTab: 'media' })
}

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
