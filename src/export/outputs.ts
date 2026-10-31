/**
 * The export dialog's outputs: plain OutputSpecs turned into ready-to-render projects and settings, and one job that
 * renders several outputs one after another.
 *
 *   const outputs = suggestedOutputs(project)                  // the dialog's starting list
 *   const planned = planOutput(project, spec)                   // framing preview, range, size and duration
 *   const job = startExport(project, outputs.selected)          // jobs: 'export.outputs', one file per output
 *
 * Teasers are a range of the timeline with short fades in and out (a black layer and audio fades in the rendered
 * project). Loops blend the moments before their start into their end (export frameTimes), so the last frame runs
 * straight into the first; with audio, the song crossfades the same way.
 */
import { produce } from 'immer'
import {
  defaultVideoBitrate,
  exportFileName,
  exportProject,
  exportSize,
  type ExportOptions,
} from '../engine/export.ts'
import type { ExportSettings } from '../engine/types.ts'
import { applyCommand, type EditCommand } from '../model/commands.ts'
import { createSolidClip, createTrack, newId } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AspectPreset, Project, Seconds } from '../model/types.ts'
import { jobs, type JobContext, type JobHandle } from '../shared/jobs.ts'
import { convertToFormat, type ClipFraming, type FormatOptions } from './formats.ts'
import {
  barTimes,
  fitTeaserRange,
  loopCrossfade,
  loopRange,
  teaserRange,
  type LoopPick,
  type TeaserPick,
  type TimeRange,
} from './ranges.ts'
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

const KIND_LABELS: Record<OutputKind, string> = { video: '', teaser: 'Teaser', loop: 'Canvas' }

/** Fade lengths of teasers, in seconds. */
export const TEASER_FADES = { videoIn: 0.3, videoOut: 0.6, audioIn: 0.25, audioOut: 1 } as const

/**
 * A new output of a kind with its defaults: 1080p at the project frame rate, high quality, auto framing. Teasers
 * and loops are vertical, and loops are silent, like Spotify Canvas.
 */
export function newOutput(project: Project, kind: OutputKind, patch: Partial<OutputSpec> = {}): OutputSpec {
  const aspect = patch.aspect ?? (kind === 'video' ? project.settings.aspect : '9:16')
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
    ...(kind === 'loop' ? { audio: false } : {}),
    ...patch,
  }
}

/**
 * The dialog's starting list: the full video and the other main orientation are selected; square, portrait, a
 * chorus teaser and a Canvas loop are offered under "Add another".
 */
export function suggestedOutputs(project: Project): { selected: OutputSpec[]; more: OutputSpec[] } {
  const own = project.settings.aspect
  const other: AspectPreset = own === '9:16' ? '16:9' : '9:16'
  const more = [
    ...(['1:1', '4:5'] as const)
      .filter((a) => a !== own)
      .map((aspect) => newOutput(project, 'video', { aspect })),
    newOutput(project, 'teaser'),
    newOutput(project, 'loop'),
  ]
  return { selected: [newOutput(project, 'video'), newOutput(project, 'video', { aspect: other })], more }
}

export interface PlannedOutput {
  spec: OutputSpec
  /** What to render: the project laid out for the output's format (with a teaser's fades). */
  project: Project
  settings: ExportSettings
  /** Timeline range rendered. */
  range: TimeRange
  duration: Seconds
  frames: number
  /** Footage framing per clip, for the framing preview and its hints. */
  framing: Record<string, ClipFraming>
  /** Footage without subject analysis; auto framing crops their centre until it exists. */
  unanalysed: string[]
  estimatedBytes: number
  fileName: string
  exportOptions: Pick<ExportOptions, 'fileName' | 'frameTimes' | 'audio'>
  /** Teaser: how the automatic range was picked (the dialog's mini song lane starts there). */
  teaser?: TeaserPick
  /** Loop: its bars, crossfade, and whether it starts and ends on bars (the seamless loop check). */
  loop?: LoopPick & { barAligned: boolean }
}

export interface PlanOptions {
  measure?: FormatOptions['measure']
}

/** The teaser's fades: black fading out at the start and in at the end, and audio fades at the range edges. */
function withTeaserFades(project: Project, range: TimeRange): Project {
  const commands: EditCommand[] = []
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'audio') continue
    const end = clip.start + clip.duration
    if (end <= range.start + 1e-3 || clip.start >= range.end - 1e-3) continue
    let inner = clip.id
    if (clip.start < range.start - 1e-3) {
      inner = `${clip.id}:teaser`
      commands.push(
        { type: 'clip.split', clipId: clip.id, time: range.start, newClipId: inner },
        { type: 'clip.set', clipId: inner, path: ['fadeIn'], value: TEASER_FADES.audioIn },
      )
    }
    if (end > range.end + 1e-3)
      commands.push(
        { type: 'clip.split', clipId: inner, time: range.end, newClipId: `${clip.id}:after` },
        { type: 'clip.set', clipId: inner, path: ['fadeOut'], value: TEASER_FADES.audioOut },
      )
  }
  const track = { ...createTrack('visual', 'Teaser fade'), id: 'export:teaser-fade' }
  const fade = (id: string, start: Seconds, duration: Seconds, from: number, to: number) => ({
    ...createSolidClip({ trackId: track.id, color: '#000000', start, duration }),
    id,
    opacity: {
      value: from,
      keyframes: [
        { time: 0, value: from, easing: 'linear' as const },
        { time: duration, value: to, easing: 'linear' as const },
      ],
    },
  })
  commands.push(
    { type: 'track.add', track, index: 0 },
    { type: 'clip.add', clip: fade('export:fade-in', range.start, TEASER_FADES.videoIn, 1, 0) },
    {
      type: 'clip.add',
      clip: fade('export:fade-out', range.end - TEASER_FADES.videoOut, TEASER_FADES.videoOut, 0, 1),
    },
  )
  return produce(project, (draft) => {
    // Locks only guard editing; the rendered copy may split anything.
    for (const t of draft.tracks) t.locked = false
    for (const cmd of commands) applyCommand(draft, cmd)
  })
}

/** Output frames of a loop: near the end, the frames just before the loop's start fade in, ending on its start. */
function loopFrameTimes(range: TimeRange, crossfade: Seconds): NonNullable<ExportOptions['frameTimes']> {
  const length = range.end - range.start
  return (t) => {
    const from = length - crossfade
    if (crossfade <= 0 || t < from) return [{ time: range.start + t, weight: 1 }]
    const x = (t - from) / crossfade
    const w = x * x * (3 - 2 * x)
    return [
      { time: range.start + t, weight: 1 - w },
      { time: range.start + t - length, weight: w },
    ]
  }
}

/**
 * The loop's audio: the range, with the moments before its start crossfaded into its end. Equal gain rather than
 * equal power: both sides sit at the same point of the bar, so their beats line up in phase and add up.
 */
function loopAudio(range: TimeRange, crossfade: Seconds): NonNullable<ExportOptions['audio']> {
  return async (render) => {
    const mix = await render({ start: range.start - crossfade, end: range.end })
    const rate = mix.sampleRate
    const n = Math.round((range.end - range.start) * rate)
    const x = Math.max(0, Math.min(Math.round(crossfade * rate), mix.length - n))
    const out = new AudioBuffer({ length: n, numberOfChannels: mix.numberOfChannels, sampleRate: rate })
    for (let c = 0; c < mix.numberOfChannels; c++) {
      const src = mix.getChannelData(c)
      const dst = out.getChannelData(c)
      for (let i = 0; i < n; i++) {
        const main = src[i + x] ?? 0
        const k = i - (n - x)
        if (k < 0) dst[i] = main
        else {
          const u = k / x
          dst[i] = main * (1 - u) + (src[k] ?? 0) * u
        }
      }
    }
    return out
  }
}

/** Everything needed to preview and render an output. Pure; cheap enough to call while the dialog changes. */
export function planOutput(project: Project, spec: OutputSpec, options: PlanOptions = {}): PlannedOutput {
  const conversion = convertToFormat(project, spec.aspect, {
    reframe: spec.reframe,
    overrides: framingOverrides(project, spec.aspect),
    measure: options.measure,
  })
  const size = exportSize(spec.aspect, spec.resolution)
  let range: TimeRange = { start: 0, end: projectDuration(project) }
  let rendered = conversion.project
  let teaser: TeaserPick | undefined
  let loop: PlannedOutput['loop']
  const exportOptions: PlannedOutput['exportOptions'] = {}
  const audio = spec.audio ?? spec.kind !== 'loop'
  if (spec.kind === 'teaser') {
    teaser = teaserRange(project) ?? undefined
    const r = spec.range ? fitTeaserRange(project, spec.range) : (teaser ?? range)
    range = { start: r.start, end: r.end }
    rendered = withTeaserFades(rendered, range)
  } else if (spec.kind === 'loop') {
    const r = spec.range ?? loopRange(project) ?? range
    range = { start: r.start, end: r.end }
    const crossfade = Math.min(loopCrossfade(range.end - range.start), range.start)
    const bars = barTimes(project)
    const onBar = (t: Seconds) => bars.some((b) => Math.abs(b - t) < 1e-3)
    loop = {
      ...range,
      bars: bars.filter((b) => b >= range.start - 1e-3 && b < range.end - 1e-3).length,
      crossfade,
      barAligned: bars.length >= 2 && onBar(range.start) && onBar(range.end),
    }
    exportOptions.frameTimes = loopFrameTimes(range, crossfade)
    if (audio) exportOptions.audio = loopAudio(range, crossfade)
  }
  if (!audio) exportOptions.audio = 'none'
  const duration = Math.max(0, range.end - range.start)
  const videoBitrate = Math.round(
    defaultVideoBitrate(size.width, size.height, spec.fps) * QUALITY_BITRATE[spec.quality],
  )
  const settings: ExportSettings = {
    ...size,
    fps: spec.fps,
    aspect: spec.aspect,
    videoBitrate,
    audioBitrate: AUDIO_BITRATE,
    range,
  }
  const fileName = exportFileName(spec.name)
  exportOptions.fileName = fileName
  return {
    spec,
    project: rendered,
    settings,
    range,
    duration,
    frames: Math.max(1, Math.round(duration * spec.fps)),
    framing: conversion.clips,
    unanalysed: conversion.unanalysed,
    estimatedBytes: Math.round(((videoBitrate + (audio ? AUDIO_BITRATE : 0)) * duration) / 8),
    fileName,
    exportOptions,
    ...(teaser ? { teaser } : {}),
    ...(loop ? { loop } : {}),
  }
}

/** Rough render time: frames divided by a frame rate that scales with frame size from a measured 1080p rate. */
export function estimateRenderSeconds(planned: PlannedOutput, framesPerSecondAt1080p = 12): number {
  const pixels = planned.settings.width * planned.settings.height
  const blended = planned.loop ? 1 + planned.loop.crossfade / Math.max(planned.duration, 1e-3) : 1
  return Math.round((planned.frames * blended) / (framesPerSecondAt1080p * ((1920 * 1080) / pixels)))
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
