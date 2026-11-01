/**
 * The export dialog's time estimate. Each checked output gets a trial in a render worker (src/export/estimate.ts),
 * one output after another, after the outputs have stayed the same for a moment. A trial is cancelled when the
 * outputs change, the dialog closes or an export starts, and none starts while an export runs; Export never waits for
 * one. Results are kept per project version and output, so reopening the dialog shows them at once.
 */
import { useEffect, useSyncExternalStore } from 'react'
import {
  estimateOutput,
  estimateRenderSeconds,
  rememberedEstimate,
  type PlannedOutput,
} from '../../export/index.ts'
import type { Project } from '../../model/index.ts'
import { JOB_KINDS, runningJobs, useJobs } from './jobs.ts'
import { appMedia } from './media.ts'
import { versionOf } from './stills.ts'

/** Lets quick changes to the outputs settle, and the dialog's stills render first, before a trial starts. */
const TRIAL_DELAY_MS = 400

/** Trial estimates in seconds by `trialKey`; null where no trial could run (the render worker cannot draw). */
const trials = new Map<string, number | null>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function trialKey(project: Project, planned: PlannedOutput): string {
  const { spec, settings, range } = planned
  return [versionOf(project), spec.kind, spec.aspect, spec.reframe, spec.quality, spec.audio]
    .concat([settings.width, settings.height, settings.fps, range.start, range.end])
    .join('|')
}

/** The trial estimates made so far, by output: for tests and for checking estimates against real exports. */
export function trialEstimates(): Record<string, number | null> {
  return Object.fromEntries(trials)
}

async function runTrials(project: Project, outputs: PlannedOutput[], signal: AbortSignal): Promise<void> {
  for (const planned of outputs) {
    const key = trialKey(project, planned)
    let seconds: number | null = null
    try {
      seconds = await estimateOutput(planned, { signal, media: appMedia })
    } catch (error) {
      if (signal.aborted) return
      console.warn('Could not time a trial of the export', error)
    }
    if (signal.aborted) return
    trials.set(key, seconds)
    changed()
  }
}

/**
 * Seconds the checked outputs take to export on this device, or null while that is still being worked out. Trials
 * run while `open` (the dialog shows its outputs). A remembered pace of an earlier export shows at once, and a trial
 * never brings the estimate below it.
 */
export function useExportEstimate(project: Project, outputs: PlannedOutput[], open: boolean): number | null {
  useSyncExternalStore(subscribe, () => version)
  const exporting = runningJobs(useJobs()).some((j) => j.kind === JOB_KINDS.export)
  useEffect(() => {
    if (!open || exporting) return
    const todo = outputs.filter((p) => !trials.has(trialKey(project, p)))
    if (!todo.length) return
    const controller = new AbortController()
    const timer = setTimeout(() => void runTrials(project, todo, controller.signal), TRIAL_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [project, outputs, open, exporting])
  let total = 0
  for (const planned of outputs) {
    const remembered = rememberedEstimate(project.id, planned)
    const trial = trials.get(trialKey(project, planned))
    if (typeof trial === 'number') total += Math.max(trial, remembered ?? 0)
    else if (remembered !== null) total += remembered
    // Without a trial the export would run on the main thread too; only the rough frame-rate guess is left.
    else if (trial === null) total += estimateRenderSeconds(planned)
    else return null
  }
  return total
}
