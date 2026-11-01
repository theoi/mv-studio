/**
 * The export dialog's time estimate. Each checked output gets a trial in a render worker (src/export/estimate.ts),
 * one output after another, after the outputs have stayed the same for a moment. A trial is cancelled when the
 * outputs or what the project draws change, the dialog closes or an export starts, and none starts while an export
 * runs; Export never waits for one. Results are kept per drawn project and output, so reopening the dialog shows
 * them at once, and while an output is timed again its last estimate stays on screen.
 *
 * A trial times this device only while nothing else keeps it busy. On a 4-core machine without a GPU, a trial that ran
 * while footage analysis worked gave 1.7 times what one on a quiet page gave, and one started a second after a reload
 * 1.3 times. So a trial waits until the page has settled and no other job runs, for a limited time. One that ran
 * under load anyway is shown but not kept: the output is timed again as soon as the app is quiet, also after the
 * dialog was closed and reopened.
 *
 * Timeline thumbnails decode video too, but aren't jobs. Right after an auto-cut into 354 shots they decoded for about
 * 50 s, and a trial started meanwhile, with no job running, gave 2.2 times one on a quiet page. So they wait while a
 * trial runs.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import {
  estimateOutput,
  estimateRenderSeconds,
  knownEstimate,
  rememberedEstimate,
  type OutputEstimate,
  type PlannedOutput,
} from '../../export/index.ts'
import type { Project } from '../../model/index.ts'
import { jobs, type JobSnapshot } from '../../shared/jobs.ts'
import { JOB_KINDS, runningJobs, useJobs } from './jobs.ts'
import { appMedia } from './media.ts'
import { holdThumbnailsUntil } from './thumbs.ts'

/** Lets quick changes to the outputs settle, and the dialog's stills render first, before a trial starts. */
const TRIAL_DELAY_MS = 400
/**
 * How long after the page loads a trial waits. A trial a second after a reload timed frames 1.3 times slower than
 * one 46 s after, with nothing else running; one 7 s after the first load did not.
 */
export const SETTLE_MS = 10_000
/**
 * How long the first trials of the dialog's outputs wait, in all, for other jobs to finish before they run anyway (and
 * are timed again later), so the dialog shows a figure while a long job, such as stems, runs.
 */
export const QUIET_WAIT_MS = 20_000
/**
 * The longest a trial holds thumbnails back, so one that never ends doesn't leave them empty. Trials took 20 to 45 s on
 * a 4-core machine without a GPU.
 */
const TRIAL_HOLD_MS = 60_000
/** Kinds of job that don't slow a trial down: exports, which no trial runs beside, and those waiting on fal.ai. */
const IDLE_KINDS: readonly string[] = [JOB_KINDS.export, JOB_KINDS.generate, JOB_KINDS.directorShots]

/** A trial's estimate (null where no trial could run), and whether nothing else was busy while it ran. */
interface Trial {
  estimate: Required<OutputEstimate> | null
  settled: boolean
}

/** Trials by `trialKey`. */
const trials = new Map<string, Trial>()
/** The latest trial of each output of a project by `latestKey`, whatever the project drew then. */
const latest = new Map<string, Trial>()
const listeners = new Set<() => void>()
let version = 0
/** A first trial is waiting for other jobs to finish. */
let waitingForJobs = false

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setWaitingForJobs(waiting: boolean): void {
  if (waiting === waitingForJobs) return
  waitingForJobs = waiting
  changed()
}

const drawnKeys = new WeakMap<Project, string>()

/**
 * What the project draws, as a short fingerprint. Analysis results are left out: background jobs write them (the
 * export dialog itself starts footage analysis, one write per clip), and they change values a frame uses, not what
 * it costs, so they don't restart a trial. So is `updatedAt`, which every dispatch stamps, those writes included.
 */
export function drawnKey(project: Project): string {
  let key = drawnKeys.get(project)
  if (key === undefined) {
    const json = JSON.stringify({ ...project, analysis: undefined, updatedAt: undefined })
    // FNV-1a.
    let hash = 0x811c9dc5
    for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 0x01000193)
    key = `${json.length.toString(36)}.${(hash >>> 0).toString(36)}`
    drawnKeys.set(project, key)
  }
  return key
}

function outputKey(planned: PlannedOutput): string {
  const { spec, settings, range } = planned
  const parts: unknown[] = [spec.kind, spec.aspect, spec.reframe, spec.quality, spec.audio]
  return parts.concat([settings.width, settings.height, settings.fps, range.start, range.end]).join('|')
}

function trialKey(project: Project, planned: PlannedOutput): string {
  return `${drawnKey(project)}|${outputKey(planned)}`
}

function latestKey(project: Project, planned: PlannedOutput): string {
  return `${project.id}|${outputKey(planned)}`
}

/** The trial estimates made so far, by output: for tests and for checking estimates against real exports. */
export function trialEstimates(): Record<string, number | null> {
  return Object.fromEntries(
    [...trials].map(([key, trial]) => [key, trial.estimate && trial.estimate.seconds]),
  )
}

/** Outputs whose trial ran while something else kept the device busy, so they will be timed again: for tests. */
export function unsettledTrials(): string[] {
  return [...trials].filter(([, trial]) => !trial.settled).map(([key]) => key)
}

/**
 * Whether a job in `list` that works on this device is running or waiting to run. A kind with a detail suffix
 * ('cloud.generate.image') counts as its base kind.
 */
export function othersBusy(list: JobSnapshot[]): boolean {
  return runningJobs(list).some((j) => !IDLE_KINDS.some((k) => j.kind === k || j.kind.startsWith(`${k}.`)))
}

/** What trials depend on besides the output; unit tests pass their own. */
export interface TrialEnvironment {
  /** Milliseconds since the page loaded. */
  pageAge(): number
  /** Whether a job that works on this device (othersBusy) is running or waiting to run. */
  busy(): boolean
  /** Calls `listener` when jobs start, progress or end. Returns stop. */
  watchJobs(listener: () => void): () => void
  estimate(planned: PlannedOutput, signal: AbortSignal): Promise<Required<OutputEstimate> | null>
  /** Holds back work that isn't a job and can wait (timeline thumbnails) until `trial` settles. */
  holdBackground(trial: Promise<unknown>): void
}

const appEnvironment: TrialEnvironment = {
  pageAge: () => performance.now(),
  busy: () => othersBusy(jobs.list()),
  watchJobs: (listener) => jobs.subscribe(() => listener()),
  estimate: (planned, signal) => estimateOutput(planned, { signal, media: appMedia }),
  holdBackground: (trial) => holdThumbnailsUntil(trial, TRIAL_HOLD_MS),
}

/**
 * Resolves once the page has settled and no other job runs, after `maxMs` at most, or when `signal` aborts.
 * `onJobs` says whether it is waiting for other jobs.
 */
function waitForQuiet(
  env: TrialEnvironment,
  signal: AbortSignal,
  maxMs: number,
  onJobs: (waiting: boolean) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let limit: ReturnType<typeof setTimeout> | undefined
    let stop = () => {}
    const done = () => {
      clearTimeout(timer)
      clearTimeout(limit)
      stop()
      signal.removeEventListener('abort', done)
      onJobs(false)
      resolve()
    }
    const check = () => {
      if (signal.aborted) return done()
      const busy = env.busy()
      const young = SETTLE_MS - env.pageAge()
      if (!busy && young <= 0) return done()
      onJobs(busy)
      clearTimeout(timer)
      if (young > 0) timer = setTimeout(check, young)
    }
    stop = env.watchJobs(check)
    if (Number.isFinite(maxMs)) limit = setTimeout(done, maxMs)
    signal.addEventListener('abort', done)
    check()
  })
}

async function timeOutput(
  project: Project,
  planned: PlannedOutput,
  signal: AbortSignal,
  env: TrialEnvironment,
): Promise<void> {
  let underLoad = env.pageAge() < SETTLE_MS || env.busy()
  const stop = env.watchJobs(() => {
    if (env.busy()) underLoad = true
  })
  let estimate: Required<OutputEstimate> | null = null
  let failed = false
  try {
    const timing = env.estimate(planned, signal)
    env.holdBackground(timing)
    estimate = await timing
  } catch (error) {
    if (signal.aborted) return
    failed = true
    console.warn('Couldn’t time a trial of the export', error)
  } finally {
    stop()
  }
  if (signal.aborted) return
  // Where no trial can run (the render worker cannot draw), or one failed on a quiet page, timing it again would not
  // help. One that failed under load (out of memory while analysis ran, say) may well work once the app is quiet.
  const trial = { estimate, settled: !underLoad || (estimate === null && !failed) }
  trials.set(trialKey(project, planned), trial)
  latest.set(latestKey(project, planned), trial)
  changed()
}

/**
 * Times each output that has no settled trial: first those with none, waiting a limited time in all for the app to be
 * quiet, then again those timed under load, each once the app is quiet. Returns when all are settled or `signal`
 * aborts.
 */
export async function runTrials(
  project: Project,
  outputs: PlannedOutput[],
  signal: AbortSignal,
  env: TrialEnvironment = appEnvironment,
): Promise<void> {
  const settled = (p: PlannedOutput) => trials.get(trialKey(project, p))?.settled === true
  const deadline = env.pageAge() + QUIET_WAIT_MS
  while (!signal.aborted) {
    const todo = outputs.filter((p) => !settled(p))
    if (!todo.length) return
    const first = todo.filter((p) => !trials.has(trialKey(project, p)))
    for (const planned of first.length ? first : todo) {
      const untimed = !trials.has(trialKey(project, planned))
      const maxMs = untimed ? Math.max(0, deadline - env.pageAge()) : Infinity
      await waitForQuiet(env, signal, maxMs, (waiting) => setWaitingForJobs(untimed && waiting))
      if (signal.aborted) return
      await timeOutput(project, planned, signal, env)
    }
  }
}

/**
 * The trial an output's figure comes from: its own (`current`), or while it has none, its latest in the project, which
 * stays on screen while the output is timed again after an edit.
 */
function shownTrial(
  project: Project,
  planned: PlannedOutput,
): { trial: Trial | undefined; current: boolean } {
  const own = trials.get(trialKey(project, planned))
  return { trial: own ?? latest.get(latestKey(project, planned)), current: own !== undefined }
}

/**
 * What is known of how long the output takes to export on this device (knownEstimate), or null while that is still
 * being worked out. A remembered pace of an earlier export counts at once.
 */
export function outputEstimate(project: Project, planned: PlannedOutput): OutputEstimate | null {
  const { trial, current } = shownTrial(project, planned)
  const estimate = trial?.estimate
  const known = knownEstimate(estimate, current, rememberedEstimate(project.id, planned))
  if (known) return known
  // Without a trial the export would run on the main thread too; only the rough frame-rate guess is left, and it can
  // be far too low for the export's time left to start from.
  return estimate === null ? { seconds: estimateRenderSeconds(planned) } : null
}

/** What the export dialog shows of the time the checked outputs take. */
export interface ExportEstimate {
  /** Seconds on this device, or null while that is still being worked out. */
  seconds: number | null
  /** No figure yet because a trial waits for other jobs to finish. */
  waitingForJobs: boolean
  /** Every checked output has had a trial, settled or not. */
  timed: boolean
  /** Some of `seconds` comes from a trial that ran under load, so it is likely too long until timed again. */
  provisional: boolean
}

/** What the export dialog shows for `outputs`, from the trials so far. */
export function currentEstimate(project: Project, outputs: PlannedOutput[]): ExportEstimate {
  const timed = outputs.every((p) => trials.has(trialKey(project, p)))
  let total: number | null = 0
  for (const planned of outputs) {
    const estimate = outputEstimate(project, planned)
    if (!estimate) {
      total = null
      break
    }
    total += estimate.seconds
  }
  // A failed trial leaves the rough guess on screen, which is no upper bound.
  const provisional =
    total !== null &&
    outputs.some((p) => {
      const { trial } = shownTrial(project, p)
      return trial?.settled === false && trial.estimate !== null
    })
  return { seconds: total, waitingForJobs: total === null && waitingForJobs, timed, provisional }
}

/** The time the checked outputs take to export on this device. Trials run while `open` (the dialog shows its outputs). */
export function useExportEstimate(project: Project, outputs: PlannedOutput[], open: boolean): ExportEstimate {
  useSyncExternalStore(subscribe, () => version)
  const exporting = runningJobs(useJobs()).some((j) => j.kind === JOB_KINDS.export)
  // A new project object or new plans of the same outputs restart nothing unless what they draw changed.
  const keys = outputs.map((p) => trialKey(project, p)).join('\n')
  const startTrials = useEffectEvent((signal: AbortSignal) => {
    if (outputs.some((p) => !trials.get(trialKey(project, p))?.settled))
      void runTrials(project, outputs, signal)
  })
  useEffect(() => {
    if (!open || exporting || !keys) return
    const controller = new AbortController()
    const timer = setTimeout(() => startTrials(controller.signal), TRIAL_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [keys, open, exporting])
  return currentEstimate(project, outputs)
}
