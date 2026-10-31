/**
 * The export dialog's outputs: plain OutputSpecs turned into ready-to-render projects and settings, and one job that
 * renders several outputs one after another.
 *
 *   const outputs = suggestedOutputs(project)                  // the dialog's starting list
 *   const planned = planOutput(project, spec)                   // framing preview, size and duration estimates
 *   const job = startExport(project, outputs.selected)          // jobs: 'export.outputs', one file per output
 */
import {
  defaultVideoBitrate,
  exportFileName,
  exportProject,
  exportSize,
  type ExportOptions,
} from '../engine/export.ts'
import type { ExportSettings } from '../engine/types.ts'
import { newId } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AspectPreset, Project, Seconds } from '../model/types.ts'
import { jobs, type JobContext, type JobHandle } from '../shared/jobs.ts'
import { convertToFormat, type ClipFraming, type FormatOptions } from './formats.ts'
import { framingOverrides } from './settings.ts'
import type { ExportQuality, OutputKind, OutputSpec } from './types.ts'

const AUDIO_BITRATE = 192_000
/** Share of the default (high quality) video bitrate. */
export const QUALITY_BITRATE: Record<ExportQuality, number> = { high: 1, balanced: 0.6, small: 0.35 }

export const FORMAT_LABELS: Record<AspectPreset, string> = {
  '16:9': 'Landscape',
  '9:16': 'Vertical',
  '1:1': 'Square',
  '4:5': 'Portrait',
}

const KIND_LABELS: Record<OutputKind, string> = { video: '', teaser: 'Teaser', loop: 'Loop' }

/** A new output of a kind with its defaults: 1080p at the project frame rate, high quality, auto framing. */
export function newOutput(project: Project, kind: OutputKind, patch: Partial<OutputSpec> = {}): OutputSpec {
  const aspect = patch.aspect ?? project.settings.aspect
  const label =
    kind === 'video' ? (aspect === project.settings.aspect ? '' : FORMAT_LABELS[aspect]) : KIND_LABELS[kind]
  return {
    id: newId(),
    kind,
    name: label ? `${project.name} - ${label}` : project.name,
    aspect,
    resolution: '1080p',
    fps: project.settings.fps,
    quality: 'high',
    reframe: 'auto',
    ...patch,
  }
}

/**
 * The dialog's starting list: the full video and the other main orientation are selected; square and portrait are
 * offered under "Add another".
 */
export function suggestedOutputs(project: Project): { selected: OutputSpec[]; more: OutputSpec[] } {
  const own = project.settings.aspect
  const other: AspectPreset = own === '9:16' ? '16:9' : '9:16'
  const more = (['1:1', '4:5'] as const)
    .filter((a) => a !== own)
    .map((aspect) => newOutput(project, 'video', { aspect }))
  return { selected: [newOutput(project, 'video'), newOutput(project, 'video', { aspect: other })], more }
}

export interface PlannedOutput {
  spec: OutputSpec
  /** What to render: the project laid out for the output's format. */
  project: Project
  settings: ExportSettings
  /** Timeline range rendered. */
  range: { start: Seconds; end: Seconds }
  duration: Seconds
  frames: number
  /** Footage framing per clip, for the framing preview and its hints. */
  framing: Record<string, ClipFraming>
  /** Footage without subject analysis; auto framing crops their centre until it exists. */
  unanalysed: string[]
  estimatedBytes: number
  fileName: string
  exportOptions: Pick<ExportOptions, 'fileName'>
}

export interface PlanOptions {
  measure?: FormatOptions['measure']
}

/** Everything needed to preview and render an output. Pure; cheap enough to call while the dialog changes. */
export function planOutput(project: Project, spec: OutputSpec, options: PlanOptions = {}): PlannedOutput {
  const conversion = convertToFormat(project, spec.aspect, {
    reframe: spec.reframe,
    overrides: framingOverrides(project, spec.aspect),
    measure: options.measure,
  })
  const size = exportSize(spec.aspect, spec.resolution)
  const range = { start: 0, end: projectDuration(project) }
  const duration = Math.max(0, range.end - range.start)
  const videoBitrate = Math.round(
    defaultVideoBitrate(size.width, size.height, spec.fps) * QUALITY_BITRATE[spec.quality],
  )
  const audio = spec.audio ?? spec.kind !== 'loop'
  const settings: ExportSettings = {
    ...size,
    fps: spec.fps,
    aspect: spec.aspect,
    videoBitrate,
    audioBitrate: AUDIO_BITRATE,
    range,
  }
  const fileName = exportFileName(spec.name)
  return {
    spec,
    project: conversion.project,
    settings,
    range,
    duration,
    frames: Math.max(1, Math.round(duration * spec.fps)),
    framing: conversion.clips,
    unanalysed: conversion.unanalysed,
    estimatedBytes: Math.round(((videoBitrate + (audio ? AUDIO_BITRATE : 0)) * duration) / 8),
    fileName,
    exportOptions: { fileName },
  }
}

/** Rough render time: frames divided by a frame rate that scales with frame size from a measured 1080p rate. */
export function estimateRenderSeconds(planned: PlannedOutput, framesPerSecondAt1080p = 12): number {
  const pixels = planned.settings.width * planned.settings.height
  return Math.round(planned.frames / (framesPerSecondAt1080p * ((1920 * 1080) / pixels)))
}

export interface OutputResult {
  spec: OutputSpec
  file: File
  durationSeconds: number
  width: number
  height: number
}

/** File names made unique within one export ("Name.mp4", "Name (2).mp4"). */
function uniqueNames(planned: PlannedOutput[]): string[] {
  const seen = new Map<string, number>()
  return planned.map((p) => {
    const n = (seen.get(p.fileName) ?? 0) + 1
    seen.set(p.fileName, n)
    return n === 1 ? p.fileName : p.fileName.replace(/\.mp4$/, ` (${n}).mp4`)
  })
}

/** Renders the outputs one after another as one job's work. Progress covers all of them, weighted by frames. */
export async function exportOutputs(
  project: Project,
  specs: readonly OutputSpec[],
  ctx: JobContext,
  options: PlanOptions & Pick<ExportOptions, 'media' | 'registry'> = {},
): Promise<OutputResult[]> {
  const planned = specs.map((spec) => planOutput(project, spec, options))
  const names = uniqueNames(planned)
  const total = planned.reduce((sum, p) => sum + p.frames, 0)
  const started = performance.now()
  const results: OutputResult[] = []
  let done = 0
  for (const [i, p] of planned.entries()) {
    const share = p.frames / total
    const offset = done / total
    const label = planned.length > 1 ? `${i + 1} of ${planned.length}: ` : ''
    const sub: JobContext = {
      signal: ctx.signal,
      throwIfCancelled: () => ctx.throwIfCancelled(),
      progress: (update) => {
        const fraction = Math.min(1, offset + share * (update.fraction ?? 0))
        const elapsed = (performance.now() - started) / 1000
        ctx.progress({
          ...update,
          fraction,
          message: `${label}${update.message ?? ''}`,
          ...(fraction > 0.02 ? { etaSeconds: Math.round((elapsed * (1 - fraction)) / fraction) } : {}),
        })
      },
    }
    const result = await exportProject(p.project, p.settings, sub, {
      media: options.media,
      registry: options.registry,
      ...p.exportOptions,
      fileName: names[i],
      // Keep the files this job already made; the first output also keeps the previous export.
      keepExports: i === 0 ? 1 : false,
    })
    results.push({
      spec: p.spec,
      file: result.file,
      durationSeconds: result.durationSeconds,
      width: p.settings.width,
      height: p.settings.height,
    })
    done += p.frames
  }
  return results
}

/** Starts the export job for the outputs. */
export function startExport(
  project: Project,
  specs: readonly OutputSpec[],
  options: PlanOptions & Pick<ExportOptions, 'media' | 'registry'> = {},
): JobHandle<OutputResult[]> {
  return jobs.run({
    kind: 'export.outputs',
    title: specs.length === 1 ? 'Exporting video' : `Exporting ${specs.length} videos`,
    run: (ctx) => exportOutputs(project, specs, ctx, options),
  })
}
