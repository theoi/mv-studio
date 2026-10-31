/**
 * MP4 export: mixes audio with the same graph as playback (offline, on the main thread, where Web Audio lives), then
 * renders and encodes in the render worker (encode.ts) so the app stays responsive. Runs as a job: progress,
 * cancellation, typed errors.
 */
import { canEncodeAudio, canEncodeVideo } from 'mediabunny'
import { readOpfsFile, removeOpfsEntry } from '../media/opfs.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { ASPECT_PRESETS } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AspectPreset, Project, Seconds } from '../model/types.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { audibleClips, AudioBufferCache, renderMix } from './audio.ts'
import { AUDIO_SAMPLE_RATE, encodeExport, type EncodeJob, type EncodeResult } from './encode.ts'
import { startRenderWorker } from './renderHost.ts'
import type { ExportResult, ExportSettings, MediaFileSource, PluginRegistry } from './types.ts'

export type ExportResolution = '720p' | '1080p' | '1440p' | '2160p'

export const EXPORT_RESOLUTIONS: { id: ExportResolution; label: string; shortSide: number }[] = [
  { id: '720p', label: '720p', shortSide: 720 },
  { id: '1080p', label: '1080p (Full HD)', shortSide: 1080 },
  { id: '1440p', label: '1440p', shortSide: 1440 },
  { id: '2160p', label: '4K', shortSide: 2160 },
]

export const EXPORT_FRAME_RATES = [24, 25, 30, 50, 60] as const

const DEFAULT_AUDIO_BITRATE = 192_000
const EXPORT_ROOT = 'exports'
/** How long a cancelled render worker may take to stop before it is terminated. */
const CANCEL_GRACE_MS = 5000
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Frame size for an aspect at a resolution, where the resolution names the shorter side (e.g. 1080p 9:16 = 1080x1920). */
export function exportSize(
  aspect: AspectPreset,
  resolution: ExportResolution,
): { width: number; height: number } {
  const base = ASPECT_PRESETS[aspect]
  const short = EXPORT_RESOLUTIONS.find((r) => r.id === resolution)?.shortSide ?? 1080
  const scale = short / Math.min(base.width, base.height)
  return { width: even(base.width * scale), height: even(base.height * scale) }
}

/** H.264 bitrate that keeps fast-moving music video content clean: about 0.16 bits per pixel at 30 fps. */
export function defaultVideoBitrate(width: number, height: number, fps: number): number {
  const bitsPerPixel = fps > 30 ? 0.12 : 0.16
  return Math.round(width * height * fps * bitsPerPixel)
}

export function defaultExportSettings(
  project: Project,
  resolution: ExportResolution = '1080p',
): ExportSettings {
  const { aspect, fps } = project.settings
  return { ...exportSize(aspect, resolution), fps, aspect }
}

/** Whether this browser can export the settings, and which AAC encoder it would use. */
export async function exportSupport(
  settings: ExportSettings,
): Promise<{ video: boolean; audio: 'native' | 'wasm' }> {
  const bitrate = settings.videoBitrate ?? defaultVideoBitrate(settings.width, settings.height, settings.fps)
  const video = await canEncodeVideo('avc', { width: settings.width, height: settings.height, bitrate })
  const audio = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: AUDIO_SAMPLE_RATE }))
    ? 'native'
    : 'wasm'
  return { video, audio }
}

/** A safe MP4 file name for a project or output name. */
export function exportFileName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]+/g, '')
    .trim()
    .replace(/\s+/g, ' ')
  return `${base.slice(0, 80) || 'MV Studio export'}.mp4`
}

/** Deletes earlier exports, keeping the most recent `keep` (their files may still be downloading). */
async function pruneExports(keep: number): Promise<void> {
  let root: FileSystemDirectoryHandle
  try {
    root = await (await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_ROOT)
  } catch {
    return
  }
  const names: string[] = []
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name)
  // Directory names start with a millisecond timestamp, so they sort by age.
  names.sort()
  for (const name of names.slice(0, Math.max(0, names.length - keep)))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined)
}
export interface ExportOptions {
  media?: MediaFileSource
  registry?: PluginRegistry
  /** File name including the extension; defaults to the project name. */
  fileName?: string
  /** Earlier exports kept in browser storage (default 1); false keeps them all, e.g. for later files of one job. */
  keepExports?: number | false
  /**
   * Project times blended into the output frame at time t (seconds from the range start), with weights that sum to
   * 1. Defaults to the single time range.start + t. Seamless loops blend their start into their end.
   */
  frameTimes?: (t: Seconds) => readonly { time: Seconds; weight: number }[]
  /** 'mix' (default): the project's mix over the range. 'none': no audio track. Or a function that makes the audio. */
  audio?:
    | 'mix'
    | 'none'
    | ((mix: (range: { start: Seconds; end: Seconds }) => Promise<AudioBuffer>) => Promise<AudioBuffer>)
}

/**
 * Exports the project to an MP4 file in browser storage. Run it as a job: jobs.run({ kind: 'export.mp4', ... }).
 * Rendering runs in the render worker unless `options` supplies a media source or plugin registry, which cannot cross
 * to a worker; then it runs in-process.
 */
export async function exportProject(
  project: Project,
  settings: ExportSettings,
  ctx: JobContext,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const media = options.media ?? mediaStore
  const width = even(settings.width)
  const height = even(settings.height)
  const fps = settings.fps
  if (!(fps > 0) || fps > 120) throw new JobError('invalid-input', `Unsupported frame rate: ${fps}`)
  const range = settings.range ?? { start: 0, end: projectDuration(project) }
  const duration = range.end - range.start
  if (!(duration > 0))
    throw new JobError('invalid-input', 'There is nothing to export yet. Add clips to the timeline first.')
  const frameCount = Math.max(1, Math.round(duration * fps))
  const videoBitrate = settings.videoBitrate ?? defaultVideoBitrate(width, height, fps)

  ctx.progress({ stage: 'prepare', message: 'Preparing export', fraction: 0 })
  if (!(await canEncodeVideo('avc', { width, height, bitrate: videoBitrate })))
    throw new JobError(
      'unsupported',
      `This browser cannot encode H.264 video at ${width}×${height}. Try a lower resolution.`,
    )
  ctx.throwIfCancelled()

  let audio: EncodeJob['audio'] = null
  if (options.audio !== 'none' && audibleClips(project).length > 0) {
    ctx.progress({ stage: 'mix', message: 'Mixing audio', fraction: 0.01 })
    const cache = new AudioBufferCache(media)
    const render = (r: { start: Seconds; end: Seconds }) => renderMix(project, cache, r, AUDIO_SAMPLE_RATE)
    const mix = typeof options.audio === 'function' ? await options.audio(render) : await render(range)
    audio = {
      sampleRate: mix.sampleRate,
      channels: Array.from({ length: mix.numberOfChannels }, (_, c) => mix.getChannelData(c).slice()),
    }
    ctx.throwIfCancelled()
  }

  if (options.keepExports !== false) await pruneExports(options.keepExports ?? 1)
  const dir = `${EXPORT_ROOT}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const { frameTimes } = options
  const job: EncodeJob = {
    project,
    width,
    height,
    fps,
    range,
    videoBitrate,
    audioBitrate: settings.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    audio,
    frameTimes: frameTimes && Array.from({ length: frameCount }, (_, i) => frameTimes(i / fps)),
    path: `${dir}/${options.fileName ?? exportFileName(project.name)}`,
  }
  try {
    const result =
      options.media || options.registry
        ? await encodeExport(job, ctx, { media, registry: options.registry })
        : await encodeInWorker(job, ctx)
    ctx.throwIfCancelled()
    const file = await readOpfsFile(job.path)
    return {
      file,
      durationSeconds: result.frameCount / fps,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
    }
  } catch (error) {
    await removeOpfsEntry(dir).catch(() => undefined)
    throw ctx.signal.aborted
      ? new JobError('cancelled', 'Export cancelled', { cause: error })
      : JobError.from(error)
  }
}

async function encodeInWorker(job: EncodeJob, ctx: JobContext): Promise<EncodeResult> {
  const worker = startRenderWorker()
  let timer: ReturnType<typeof setTimeout> | undefined
  // A worker that does not stop soon after cancelling (a hung GPU, for example) is terminated.
  const onAbort = () => (timer = setTimeout(() => worker.dispose(), CANCEL_GRACE_MS))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await worker.exportVideo(job, {
      signal: ctx.signal,
      onProgress: (p) => ctx.progress(p),
      transfer: job.audio?.channels.map((c) => c.buffer) ?? [],
    })
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    clearTimeout(timer)
    worker.dispose()
  }
}
