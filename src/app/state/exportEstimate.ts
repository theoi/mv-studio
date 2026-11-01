/**
 * The export dialog's time estimate. Each checked output gets a trial in a render worker (src/export/estimate.ts),
 * one output after another, after the outputs have stayed the same for a moment. A trial is cancelled when the
 * outputs or what the project draws change, the dialog closes or an export starts, and none starts while an export
 * runs; Export never waits for one. Results are kept per drawn project and output, so reopening the dialog shows
 * them at once, and while an output is timed again its last estimate stays on screen.
 */
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import {
  estimateOutput,
  estimateRenderSeconds,
  rememberedEstimate,
  type OutputEstimate,
  type PlannedOutput,
} from '../../export/index.ts'
import type { Project } from '../../model/index.ts'
import { JOB_KINDS, runningJobs, useJobs } from './jobs.ts'
import { appMedia } from './media.ts'

/** Lets quick changes to the outputs settle, and the dialog's stills render first, before a trial starts. */
const TRIAL_DELAY_MS = 400

/** Trial estimates by `trialKey`; null where no trial could run (the render worker cannot draw). */
const trials = new Map<string, Required<OutputEstimate> | null>()
/** The latest trial estimate of each output of a project by `latestKey`, whatever the project drew then. */
const latest = new Map<string, Required<OutputEstimate> | null>()
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
  return Object.fromEntries([...trials].map(([key, trial]) => [key, trial && trial.seconds]))
}

async function runTrials(project: Project, outputs: PlannedOutput[], signal: AbortSignal): Promise<void> {
  for (const planned of outputs) {
    const key = trialKey(project, planned)
    let estimate: Required<OutputEstimate> | null = null
    try {
      estimate = await estimateOutput(planned, { signal, media: appMedia })
    } catch (error) {
      if (signal.aborted) return
      console.warn('Could not time a trial of the export', error)
    }
    if (signal.aborted) return
    trials.set(key, estimate)
    latest.set(latestKey(project, planned), estimate)
    changed()
  }
}

/**
 * What is known of how long the output takes to export on this device, or null while that is still being worked
 * out. A remembered pace of an earlier export counts at once, and a trial never brings the estimate below it. What a
 * trial expects of the frames comes only from a trial of the project as it draws now.
 */
export function outputEstimate(project: Project, planned: PlannedOutput): OutputEstimate | null {
  const remembered = rememberedEstimate(project.id, planned)
  const key = trialKey(project, planned)
  const current = trials.has(key)
  const trial = current ? trials.get(key) : latest.get(latestKey(project, planned))
  if (trial)
    return {
      seconds: Math.max(trial.seconds, remembered ?? 0),
      ...(current ? { expected: trial.expected } : {}),
    }
  if (remembered !== null) return { seconds: remembered }
  // Without a trial the export would run on the main thread too; only the rough frame-rate guess is left.
  if (trial === null) return { seconds: estimateRenderSeconds(planned) }
  return null
}

/**
 * Seconds the checked outputs take to export on this device, or null while that is still being worked out. Trials
 * run while `open` (the dialog shows its outputs).
 */
export function useExportEstimate(project: Project, outputs: PlannedOutput[], open: boolean): number | null {
  useSyncExternalStore(subscribe, () => version)
  const exporting = runningJobs(useJobs()).some((j) => j.kind === JOB_KINDS.export)
  // A new project object or new plans of the same outputs restart nothing unless what they draw changed.
  const keys = outputs.map((p) => trialKey(project, p)).join('\n')
  const startTrials = useEffectEvent((signal: AbortSignal) => {
    const todo = outputs.filter((p) => !trials.has(trialKey(project, p)))
    if (todo.length) void runTrials(project, todo, signal)
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
  let total = 0
  for (const planned of outputs) {
    const estimate = outputEstimate(project, planned)
    if (!estimate) return null
    total += estimate.seconds
  }
  return total
}
