import {
  FORMAT_LABELS,
  exportPreferences,
  newOutput,
  setOutputsCommand,
  startExport,
  suggestedOutputs,
  type OutputSpec,
  type PlannedOutput,
} from '../../../export/index.ts'
import type { AspectPreset, Project } from '../../../model/index.ts'
import { JobError, jobs } from '../../../shared/jobs.ts'
import { formatTime } from '../../format.ts'
import { downloadFile, showExport, useExports } from '../../state/exports.ts'
import { JOB_KINDS, runningJobs } from '../../state/jobs.ts'
import { appMedia } from '../../state/media.ts'
import { dispatch } from '../../state/project.ts'
import { toast } from '../../state/ui.ts'

export interface OutputItem {
  spec: OutputSpec
  /** Included in the next export. */
  on: boolean
}

export const RATIO: Record<AspectPreset, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }

const RESOLUTION_LABELS: Record<OutputSpec['resolution'], string> = {
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '2160p': '4K',
}

/** The row title: what the output is, independent of its file name. */
export function outputTitle(project: Project, spec: Pick<OutputSpec, 'kind' | 'aspect'>): string {
  if (spec.kind === 'teaser') return 'Chorus teaser'
  if (spec.kind === 'loop') return 'Loop for Canvas'
  return spec.aspect === project.settings.aspect ? 'Full video' : FORMAT_LABELS[spec.aspect]
}

export function outputSummary(project: Project, spec: OutputSpec): string {
  if (spec.kind === 'teaser') return '15–30 s highlight of the chorus'
  if (spec.kind === 'loop') return 'Seamless 3–8 s vertical loop'
  return spec.aspect === project.settings.aspect
    ? 'The whole video as edited'
    : `${spec.aspect}, reframed to the subject`
}

export function specsLine(planned: PlannedOutput): string {
  const { spec, duration } = planned
  const length =
    spec.kind === 'teaser'
      ? `${Math.round(duration)} s`
      : spec.kind === 'loop'
        ? `${Math.round(duration)} s loop`
        : formatTime(duration)
  return `${spec.aspect} · ${RESOLUTION_LABELS[spec.resolution]} · ${spec.fps} fps · ${length}`
}

/** Outputs fill the same slot when they make the same kind of file (videos: in the same format). */
function sameSlot(a: OutputSpec, b: OutputSpec): boolean {
  return a.kind === b.kind && (a.kind !== 'video' || a.aspect === b.aspect)
}

/** The dialog's starting list: the outputs saved with the project, else the suggested ones. */
export function initialItems(project: Project): OutputItem[] {
  const saved = exportPreferences(project).outputs
  const specs = saved?.length ? saved : suggestedOutputs(project).selected
  return specs.map((spec) => ({ spec, on: true }))
}

/** Every suggested output, for "Add another" (those already in the list are hidden). */
export function candidateOutputs(project: Project): OutputSpec[] {
  const { selected, more } = suggestedOutputs(project)
  return [...selected, ...more]
}

export function remainingCandidates(candidates: OutputSpec[], items: OutputItem[]): OutputSpec[] {
  return candidates.filter((c) => !items.some((i) => sameSlot(i.spec, c)))
}

/** A fresh output (with its own id) for a candidate. */
export function addCandidate(project: Project, candidate: OutputSpec): OutputSpec {
  return newOutput(project, candidate.kind, { aspect: candidate.aspect })
}

/** Changes the format, renaming the output when it still has the default name of its old format. */
export function withAspect(project: Project, spec: OutputSpec, aspect: AspectPreset): OutputSpec {
  const defaultName = (a: AspectPreset) => newOutput(project, spec.kind, { aspect: a }).name
  return { ...spec, aspect, name: spec.name === defaultName(spec.aspect) ? defaultName(aspect) : spec.name }
}

/** The moment shown for an output: the playhead for videos, just past the start (and its fade) for short ones. */
export function stillTime(planned: PlannedOutput, playhead: number): number {
  const { range, duration } = planned
  const t =
    planned.spec.kind === 'video'
      ? Math.min(Math.max(playhead, range.start), Math.max(range.start, range.end - 0.05))
      : range.start + Math.min(1.5, duration / 2)
  return Math.round(t * 100) / 100
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1e9
    ? `About ${(bytes / 1e9).toFixed(1)} GB`
    : `About ${Math.max(1, Math.round(bytes / 1e6))} MB`
}

export function timeLabel(seconds: number): string {
  return seconds < 60
    ? 'Under a minute on this device'
    : `About ${Math.round(seconds / 60)} min on this device`
}

/**
 * Saves the outputs with the project and renders them one after another in one job; every file downloads when the
 * job finishes. Returns false when another export is still running.
 */
export function startOutputs(project: Project, planned: PlannedOutput[]): boolean {
  if (runningJobs(jobs.list()).some((j) => j.kind === JOB_KINDS.export)) {
    toast('An export is already running. Wait for it to finish or cancel it first.')
    return false
  }
  const specs = planned.map((p) => p.spec)
  const saved = exportPreferences(project).outputs ?? null
  if (JSON.stringify(saved) !== JSON.stringify(specs))
    dispatch(setOutputsCommand(project, specs), { label: 'Save export outputs' })
  const handle = startExport(project, specs, { media: appMedia })
  showExport(
    handle.id,
    planned.map((p) => ({
      id: p.spec.id,
      title: outputTitle(project, p.spec),
      aspect: p.spec.aspect,
      frames: p.frames,
    })),
  )
  handle.promise.then(
    (results) => {
      if (useExports.getState().jobId === handle.id)
        useExports.setState({ files: Object.fromEntries(results.map((r) => [r.spec.id, r.file])) })
      for (const r of results) downloadFile(r.file, r.file.name)
      toast(
        results.length === 1
          ? `Saved ${results[0]?.file.name ?? 'the video'} to Downloads`
          : `Saved ${results.length} files to Downloads`,
      )
    },
    (error: unknown) => {
      if (error instanceof JobError && error.code === 'cancelled') return
      toast(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  return true
}
