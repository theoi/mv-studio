/**
 * MP4 export: renders every frame with the same compositor as preview (fed by the frame-exact WebCodecs decoder),
 * mixes audio with the same graph as playback (offline), and encodes H.264 + AAC with mediabunny, streaming the file
 * to OPFS so memory stays flat for full-length songs. Runs as a job: progress, cancellation, typed errors.
 */
import {
  AudioBufferSource,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from 'mediabunny'
import { createOpfsWritable, removeOpfsEntry } from '../media/opfs.ts'
import { mediaStore } from '../media/mediaStore.ts'
import { ASPECT_PRESETS } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type { AspectPreset, Project, Seconds } from '../model/types.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { audibleClips, AudioBufferCache, renderMix } from './audio.ts'
import { WebGLCompositor } from './compositor.ts'
import { DecoderFrameProvider } from './frames.ts'
import type { ExportResult, ExportSettings, MediaFileSource, PluginRegistry } from './types.ts'

export type ExportResolution = '720p' | '1080p' | '1440p' | '2160p'

export const EXPORT_RESOLUTIONS: { id: ExportResolution; label: string; shortSide: number }[] = [
  { id: '720p', label: '720p', shortSide: 720 },
  { id: '1080p', label: '1080p (Full HD)', shortSide: 1080 },
  { id: '1440p', label: '1440p', shortSide: 1440 },
  { id: '2160p', label: '4K', shortSide: 2160 },
]

export const EXPORT_FRAME_RATES = [24, 25, 30, 50, 60] as const

const AUDIO_SAMPLE_RATE = 48_000
const DEFAULT_AUDIO_BITRATE = 192_000
const EXPORT_ROOT = 'exports'

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

let aacFallback: Promise<void> | null = null

/** Uses the browser's AAC encoder, or loads the WebAssembly one (Chrome on Linux has none). */
async function ensureAacEncoder(bitrate: number): Promise<'native' | 'wasm'> {
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: AUDIO_SAMPLE_RATE, bitrate }))
    return 'native'
  aacFallback ??= import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => registerAacEncoder())
  await aacFallback
  return 'wasm'
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

function fileNameFor(project: Project): string {
  const base = project.name
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

/** One-second (or shorter) slice of a mix, as the AudioBuffer mediabunny encodes. */
function sliceBuffer(mix: AudioBuffer, from: Seconds, seconds: Seconds): AudioBuffer {
  const start = Math.round(from * mix.sampleRate)
  const length = Math.min(Math.round(seconds * mix.sampleRate), mix.length - start)
  const out = new AudioBuffer({ length, numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate })
  for (let c = 0; c < mix.numberOfChannels; c++)
    out.copyToChannel(mix.getChannelData(c).subarray(start, start + length), c)
  return out
}

function toJobError(error: unknown): JobError {
  if (error instanceof JobError) return error
  const name = (error as { name?: string })?.name
  if (name === 'EncodingError' || name === 'NotSupportedError')
    return new JobError('encode', 'The browser could not encode the video. Try a lower resolution.', {
      cause: error,
    })
  return JobError.from(error)
}

export interface ExportOptions {
  media?: MediaFileSource
  registry?: PluginRegistry
}

/** Exports the project to an MP4 file in browser storage. Run it as a job: jobs.run({ kind: 'export.mp4', ... }). */
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
  const audioBitrate = settings.audioBitrate ?? DEFAULT_AUDIO_BITRATE

  ctx.progress({ stage: 'prepare', message: 'Preparing export', fraction: 0 })
  if (!(await canEncodeVideo('avc', { width, height, bitrate: videoBitrate })))
    throw new JobError(
      'unsupported',
      `This browser cannot encode H.264 video at ${width}×${height}. Try a lower resolution.`,
    )
  const hasAudio = audibleClips(project).length > 0
  if (hasAudio) await ensureAacEncoder(audioBitrate)
  ctx.throwIfCancelled()

  let mix: AudioBuffer | null = null
  if (hasAudio) {
    ctx.progress({ stage: 'mix', message: 'Mixing audio', fraction: 0.01 })
    mix = await renderMix(project, new AudioBufferCache(media), range, AUDIO_SAMPLE_RATE)
    ctx.throwIfCancelled()
  }

  await pruneExports(1)
  const dir = `${EXPORT_ROOT}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const fileName = fileNameFor(project)
  const { writable, handle } = await createOpfsWritable(`${dir}/${fileName}`)
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable as unknown as WritableStream, { chunked: true }),
  })
  const canvas = new OffscreenCanvas(width, height)
  const frames = new DecoderFrameProvider(media)
  const compositor = new WebGLCompositor({
    canvas,
    frames,
    media,
    registry: options.registry,
    preserveDrawingBuffer: true,
  })
  let videoCodec = 'avc'
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: videoBitrate,
    keyFrameInterval: 2,
    latencyMode: 'quality',
    onEncoderConfig: (config) => {
      videoCodec = config.codec
    },
  })
  output.addVideoTrack(video, { frameRate: fps })
  let audioCodec = 'none'
  const audio = mix
    ? new AudioBufferSource({
        codec: 'aac',
        bitrate: audioBitrate,
        onEncoderConfig: (config) => {
          audioCodec = config.codec
        },
      })
    : null
  if (audio) output.addAudioTrack(audio)

  const abort = () => void output.cancel().catch(() => undefined)
  ctx.signal.addEventListener('abort', abort, { once: true })
  try {
    await output.start()
    let audioSent = 0
    const sendAudioUntil = async (t: Seconds) => {
      if (!audio || !mix) return
      while (audioSent < Math.min(duration, t)) {
        const seconds = Math.min(1, duration - audioSent)
        await audio.add(sliceBuffer(mix, audioSent, seconds))
        audioSent += seconds
      }
    }
    const started = performance.now()
    for (let i = 0; i < frameCount; i++) {
      ctx.throwIfCancelled()
      const t = i / fps
      // Keep audio about a second ahead of video so the muxer can interleave without buffering much.
      await sendAudioUntil(t + 1)
      await compositor.render(project, range.start + t)
      await video.add(t, 1 / fps)
      if (i % 5 === 0 || i === frameCount - 1) {
        const elapsed = (performance.now() - started) / 1000
        const rate = (i + 1) / Math.max(elapsed, 1e-3)
        ctx.progress({
          stage: 'render',
          fraction: 0.02 + (0.96 * (i + 1)) / frameCount,
          message: `Rendering frame ${i + 1} of ${frameCount}`,
          etaSeconds: Math.round((frameCount - i - 1) / rate),
        })
      }
    }
    await sendAudioUntil(duration)
    ctx.throwIfCancelled()
    video.close()
    audio?.close()
    ctx.progress({ stage: 'finalize', message: 'Finishing the file', fraction: 0.99 })
    await output.finalize()
    const file = await handle.getFile()
    return { file, durationSeconds: frameCount / fps, videoCodec, audioCodec }
  } catch (error) {
    if (output.state !== 'canceled') await output.cancel().catch(() => undefined)
    await removeOpfsEntry(dir).catch(() => undefined)
    throw ctx.signal.aborted
      ? new JobError('cancelled', 'Export cancelled', { cause: error })
      : toJobError(error)
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    compositor.dispose()
    frames.dispose()
  }
}
