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
import type { ExportSettings, MediaFileSource } from '../engine/types.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { applyCommand, type EditCommand } from '../model/commands.ts'
import { createSolidClip, createTrack, newId } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AspectPreset, Project, Seconds } from '../model/types.ts'
import { JobError, jobs, type JobContext, type JobHandle } from '../shared/jobs.ts'
import { rememberPace, type ExportPaceStore, type OutputEstimate } from './estimate.ts'
import { convertToFormat, type ClipFraming, type FormatConversion, type FormatOptions } from './formats.ts'
import {
  barTimes,
  fitTeaserRange,
  loopCrossfade,
  loopRange,
  placeLoop,
  sectionEndAt,
  teaserRange,
  teaserWindow,
  type LoopLength,
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
 * The dialog's starting list: the full video and the other main orientation are listed; square, portrait, a chorus
 * teaser and a Canvas loop are offered under "Add another".
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
  /**
   * The file's size at the encoders' target bitrates. A file comes near it on busy footage and well under it on easy
   * content (a software H.264 encoder made a third of it for the sample project), so it is about the most it takes.
   */
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

/**
 * Everything needed to preview and render an output. Pure; cheap enough to call while the dialog changes: the
 * project laid out for the output's format (`project`, `framing`, `unanalysed`) is worked out when first read.
 */
export function planOutput(project: Project, spec: OutputSpec, options: PlanOptions = {}): PlannedOutput {
  let conversion: FormatConversion | undefined
  const convert = () =>
    (conversion ??= convertToFormat(project, spec.aspect, {
      reframe: spec.reframe,
      overrides: framingOverrides(project, spec.aspect),
      measure: options.measure,
    }))
  const size = exportSize(spec.aspect, spec.resolution)
  let range: TimeRange = { start: 0, end: projectDuration(project) }
  let rendered: Project | undefined
  let teaser: TeaserPick | undefined
  let loop: PlannedOutput['loop']
  const exportOptions: PlannedOutput['exportOptions'] = {}
  const audio = spec.audio ?? spec.kind !== 'loop'
  if (spec.kind === 'teaser') {
    const window = teaserWindow(spec.maxLength)
    const auto = teaserRange(project, window)
    // A chosen length is a promise: run as close to it as the bars allow, not just past its minimum.
    teaser =
      auto && spec.maxLength
        ? { ...auto, ...fitTeaserRange(project, { start: auto.start, end: auto.start + window.max }, window) }
        : (auto ?? undefined)
    const r = spec.range ? fitTeaserRange(project, spec.range, window) : (teaser ?? range)
    range = { start: r.start, end: r.end }
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
    get project() {
      rendered ??= spec.kind === 'teaser' ? withTeaserFades(convert().project, range) : convert().project
      return rendered
    },
    settings,
    range,
    duration,
    frames: Math.max(1, Math.round(duration * spec.fps)),
    get framing() {
      return convert().clips
    },
    get unanalysed() {
      return convert().unanalysed
    },
    estimatedBytes: Math.round(((videoBitrate + (audio ? AUDIO_BITRATE : 0)) * duration) / 8),
    fileName,
    exportOptions,
    ...(teaser ? { teaser } : {}),
    ...(loop ? { loop } : {}),
  }
}

/** A planned loop's length: its bars when it starts and ends on them, else its seconds. */
export function loopLengthOf(planned: PlannedOutput): LoopLength {
  const loop = planned.loop
  return loop?.barAligned && loop.bars > 0
    ? { bars: loop.bars, seconds: planned.duration }
    : { bars: 0, seconds: planned.duration }
}

/**
 * The range a teaser or loop gets when its start is moved to `start` (dragged on the dialog's song lane): the same
 * length, on bars, inside the timeline. Null for full videos, or when the loop's bars no longer fit.
 */
export function movedRange(project: Project, planned: PlannedOutput, start: Seconds): TimeRange | null {
  const { spec, range } = planned
  if (spec.kind === 'teaser')
    return fitTeaserRange(
      project,
      { start, end: start + (range.end - range.start) },
      teaserWindow(spec.maxLength),
    )
  if (spec.kind !== 'loop') return null
  const pick = placeLoop(project, start, loopLengthOf(planned))
  return pick && { start: pick.start, end: pick.end }
}

/**
 * The spec changes for a new teaser length (null: as long as the section it starts on): a range the user placed
 * keeps its start; an automatic one is picked again for the new length.
 */
export function teaserLengthPatch(
  project: Project,
  planned: PlannedOutput,
  maxLength: Seconds | null,
): Pick<OutputSpec, 'maxLength' | 'range'> {
  const { spec, range } = planned
  if (!spec.range) return { maxLength: maxLength ?? undefined }
  const window = teaserWindow(maxLength ?? undefined)
  const sectionEnd = sectionEndAt(project, range.start)
  const wanted = maxLength ?? (sectionEnd !== null ? sectionEnd - range.start : range.end - range.start)
  return {
    maxLength: maxLength ?? undefined,
    range: fitTeaserRange(project, { start: range.start, end: range.start + wanted }, window),
  }
}

/** The range of a loop of `length` starting where the planned loop starts. Null when those bars don't fit. */
export function loopLengthRange(
  project: Project,
  planned: PlannedOutput,
  length: LoopLength,
): TimeRange | null {
  const pick = placeLoop(project, planned.range.start, length)
  return pick && { start: pick.start, end: pick.end }
}

/**
 * The two frames either side of a loop's seam: what its last frame shows (the moment just before its start when it
 * crossfades, else its own end) and its first frame. When they look alike, the loop plays without a jump.
 */
export function loopSeam(planned: PlannedOutput): { last: Seconds; first: Seconds } | null {
  const loop = planned.loop
  if (!loop) return null
  const frame = 1 / planned.spec.fps
  const round = (t: Seconds) => Math.round(Math.max(0, t) * 1000) / 1000
  return { last: round(loop.crossfade > 0 ? loop.start - frame : loop.end - frame), first: round(loop.start) }
}

/**
 * Rough render time: frames divided by a frame rate that scales with frame size from a measured 1080p rate. It knows
 * nothing of the project, so it can be far too low; the export dialog uses it only where no trial can run
 * (estimate.ts).
 */
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

export interface ExportOutputsOptions extends PlanOptions, Pick<ExportOptions, 'media' | 'registry'> {
  /** Called as each file finishes, so it can be saved before the rest are done (or cancelled). */
  onOutput?: (result: OutputResult) => void
  /** Where each finished output's pace is kept for later estimates (default: this browser's localStorage). */
  pace?: ExportPaceStore
  /** What was worked out before the export of each output's time, by spec id. */
  estimates?: Readonly<Record<string, OutputEstimate>>
}

/**
 * Renders the outputs one after another as one job's work. Progress covers all of them, weighted by frames. The time
 * left is the output rendering's own (from its trial's expected time, then its pace) plus the estimates of the
 * outputs after it; without either, none shows.
 */
export async function exportOutputs(
  project: Project,
  specs: readonly OutputSpec[],
  ctx: JobContext,
  options: ExportOutputsOptions = {},
): Promise<OutputResult[]> {
  const planned = specs.map((spec) => planOutput(project, spec, options))
  const names = uniqueNames(planned)
  const total = planned.reduce((sum, p) => sum + p.frames, 0)
  const estimate = (p: PlannedOutput) => options.estimates?.[p.spec.id]
  const results: OutputResult[] = []
  let done = 0
  for (const [i, p] of planned.entries()) {
    const share = p.frames / total
    const offset = done / total
    const label = planned.length > 1 ? `${i + 1} of ${planned.length}: ` : ''
    const waiting = planned.slice(i + 1).map((next) => estimate(next)?.seconds)
    const later = waiting.every((s): s is number => s !== undefined)
      ? waiting.reduce((sum, s) => sum + s, 0)
      : undefined
    const sub: JobContext = {
      signal: ctx.signal,
      throwIfCancelled: () => ctx.throwIfCancelled(),
      progress: (update) => {
        const fraction = Math.min(1, offset + share * (update.fraction ?? 0))
        // Before its frames this output has its whole estimate left, and while it finishes the file, nothing.
        const own =
          update.stage === 'render'
            ? update.etaSeconds
            : update.stage === 'finalize'
              ? 0
              : estimate(p)?.seconds
        ctx.progress({
          ...update,
          fraction,
          message: `${label}${update.message ?? ''}`,
          etaSeconds: own === undefined || later === undefined ? undefined : Math.round(own + later),
        })
      },
    }
    const outputStarted = performance.now()
    const result = await exportProject(p.project, p.settings, sub, {
      media: options.media,
      registry: options.registry,
      ...p.exportOptions,
      expected: estimate(p)?.expected,
      fileName: names[i],
      // Keep the files this job already made; the first output also keeps the previous export.
      keepExports: i === 0 ? 1 : false,
    })
    const output: OutputResult = {
      spec: p.spec,
      file: result.file,
      durationSeconds: result.durationSeconds,
      width: p.settings.width,
      height: p.settings.height,
    }
    rememberPace(project.id, p, (performance.now() - outputStarted) / 1000, options.pace)
    results.push(output)
    options.onOutput?.(output)
    done += p.frames
  }
  return results
}

/**
 * Why an export failed, when the project's media are no longer stored: the browser cleared the site's storage, as it
 * does when the disk is nearly full, and the export then finds neither its media nor the file it was writing. The
 * error itself only says a file couldn't be found.
 */
export async function exportFailure(
  error: unknown,
  project: Project,
  media: MediaFileSource,
): Promise<unknown> {
  if (error instanceof JobError && error.code === 'cancelled') return error
  const assets = Object.values(project.assets)
  const stored = await Promise.all(
    assets.map((a) =>
      media.getFile(a).then(
        () => true,
        () => false,
      ),
    ),
  )
  if (stored.every(Boolean)) return error
  return new JobError(
    'storage-quota',
    'The browser cleared this project’s media, as it does when the disk is nearly full.',
    { cause: error },
  )
}

/** Starts the export job for the outputs. */
export function startExport(
  project: Project,
  specs: readonly OutputSpec[],
  options: ExportOutputsOptions = {},
): JobHandle<OutputResult[]> {
  return jobs.run({
    kind: 'export.outputs',
    title: specs.length === 1 ? 'Exporting video' : `Exporting ${specs.length} videos`,
    run: (ctx) =>
      exportOutputs(project, specs, ctx, options).catch(async (error: unknown) => {
        throw await exportFailure(error, project, options.media ?? mediaStore)
      }),
  })
}
