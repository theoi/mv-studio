/**
 * Renders and encodes an export to an OPFS file: the same compositor as preview, fed by the frame-exact WebCodecs
 * decoder, encoding H.264 + AAC with mediabunny and streaming to disk so memory stays flat for full-length songs. Runs
 * in the render worker (renderHost.ts), or in-process when an export is given its own plugin registry.
 */
import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  canEncodeAudio,
  Mp4OutputFormat,
  NullTarget,
  Output,
  StreamTarget,
} from 'mediabunny'
import { createOpfsWritable } from '../media/opfs.ts'
import type { Project, Seconds } from '../model/types.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'
import { WebGLCompositor } from './compositor.ts'
import { exportTimeLeft, type ExpectedTime } from './exportTime.ts'
import { DecoderFrameProvider } from './frames.ts'
import type { MediaFileSource, PluginRegistry } from './types.ts'

export const AUDIO_SAMPLE_RATE = 48_000

/** Everything an export needs besides media, as plain transferable data. */
export interface EncodeJob {
  project: Project
  width: number
  height: number
  fps: number
  range: { start: Seconds; end: Seconds }
  videoBitrate: number
  audioBitrate: number
  /** The mix of `range`, one array per channel, or null for a silent video. */
  audio: { sampleRate: number; channels: Float32Array[] } | null
  /**
   * For each output frame, the project times blended into it, with weights that sum to 1 (seamless loops). Default:
   * the single time range.start + i / fps.
   */
  frameTimes?: (readonly { time: Seconds; weight: number }[])[]
  /** OPFS path of the output file. */
  path: string
  /** What a trial before the export expects of its frames, for the time left (exportTimeLeft). */
  expected?: ExpectedTime
}

export interface EncodeResult {
  frameCount: number
  videoCodec: string
  audioCodec: string
}

export interface EncodeContext {
  readonly signal: AbortSignal
  progress(update: JobProgress): void
}

let aacFallback: Promise<void> | null = null

/** Uses the browser's AAC encoder, or loads the WebAssembly one (Chrome on Linux has none). */
export async function ensureAacEncoder(bitrate: number): Promise<'native' | 'wasm'> {
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: AUDIO_SAMPLE_RATE, bitrate }))
    return 'native'
  aacFallback ??= import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => registerAacEncoder())
  await aacFallback
  return 'wasm'
}

/** One second (or less) of the mix as planar samples for the encoder, or null past the end. */
function audioSlice(
  mix: NonNullable<EncodeJob['audio']>,
  from: Seconds,
  seconds: Seconds,
): AudioSample | null {
  const start = Math.round(from * mix.sampleRate)
  const total = mix.channels[0]?.length ?? 0
  const length = Math.min(Math.round(seconds * mix.sampleRate), total - start)
  if (length <= 0) return null
  const data = new Float32Array(length * mix.channels.length)
  mix.channels.forEach((channel, c) => data.set(channel.subarray(start, start + length), c * length))
  return new AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: mix.channels.length,
    sampleRate: mix.sampleRate,
    timestamp: from,
  })
}

function toJobError(error: unknown): JobError {
  if (error instanceof JobError) return error
  const name = (error as { name?: string })?.name
  if (name === 'EncodingError' || name === 'NotSupportedError')
    return new JobError('encode', 'The browser couldn’t encode the video. Try a lower resolution.', {
      cause: error,
    })
  return JobError.from(error)
}

/** What drawing an export's frames needs from its job. */
type FrameJob = Pick<EncodeJob, 'project' | 'width' | 'height' | 'fps' | 'range' | 'frameTimes'>

/**
 * Draws output frame `i` of a job into `canvas`: one compositor render, or for blended frames (loops) a weighted
 * average of several, each from a renderer of its own.
 */
function frameDrawer(job: FrameJob, options: { media: MediaFileSource; registry?: PluginRegistry }) {
  const { width, height, fps, range } = job
  const renderers: { compositor: WebGLCompositor; frames: DecoderFrameProvider; canvas: OffscreenCanvas }[] =
    []
  const renderer = (k: number) => {
    let r = renderers[k]
    if (!r) {
      // One decoder per blended time stream, so each decodes forward instead of seeking back and forth.
      const frames = new DecoderFrameProvider(options.media)
      const canvas = new OffscreenCanvas(width, height)
      const compositor = new WebGLCompositor({
        canvas,
        frames,
        media: options.media,
        registry: options.registry,
        preserveDrawingBuffer: true,
      })
      r = { compositor, frames, canvas }
      renderers[k] = r
    }
    return r
  }
  const blend = job.frameTimes
  const blendCanvas = blend ? new OffscreenCanvas(width, height) : null
  const blendContext = blendCanvas?.getContext('2d') ?? null
  if (blend && !blendContext) throw new JobError('unsupported', 'This browser cannot blend video frames.')
  const { compositor, canvas } = renderer(0)
  return {
    canvas: blendCanvas ?? canvas,
    /** Compositor renders frame `i` takes. */
    renders: (i: number) => blend?.[i]?.length ?? 1,
    async draw(i: number) {
      if (!blend || !blendContext) return compositor.render(job.project, range.start + i / fps)
      let weight = 0
      for (const [k, layer] of (blend[i] ?? []).entries()) {
        const r = renderer(k)
        await r.compositor.render(job.project, layer.time)
        weight += layer.weight
        // Each layer's share of the running average; the first replaces the previous output frame outright.
        blendContext.globalCompositeOperation = k === 0 ? 'copy' : 'source-over'
        blendContext.globalAlpha = k === 0 ? 1 : layer.weight / Math.max(weight, 1e-6)
        blendContext.drawImage(r.canvas, 0, 0)
      }
    },
    dispose() {
      for (const r of renderers) {
        r.compositor.dispose()
        r.frames.dispose()
      }
    },
  }
}

/**
 * Renders every frame of `job.range` and writes the MP4 to `job.path`. Throws JobErrors. The caller checks that the
 * browser can encode H.264 at the job's size.
 */
export async function encodeExport(
  job: EncodeJob,
  ctx: EncodeContext,
  options: { media: MediaFileSource; registry?: PluginRegistry },
): Promise<EncodeResult> {
  const { fps, range, audio: mix } = job
  const duration = range.end - range.start
  const frameCount = Math.max(1, Math.round(duration * fps))
  const throwIfCancelled = () => {
    if (ctx.signal.aborted) throw new JobError('cancelled', 'Export cancelled')
  }
  if (mix) await ensureAacEncoder(job.audioBitrate)
  throwIfCancelled()

  const { writable } = await createOpfsWritable(job.path)
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable as unknown as WritableStream, { chunked: true }),
  })
  const drawer = frameDrawer(job, options)
  let videoCodec = 'avc'
  const video = new CanvasSource(drawer.canvas, {
    codec: 'avc',
    bitrate: job.videoBitrate,
    keyFrameInterval: 2,
    latencyMode: 'quality',
    onEncoderConfig: (config) => {
      videoCodec = config.codec
    },
  })
  output.addVideoTrack(video, { frameRate: fps })
  let audioCodec = 'none'
  const audio = mix
    ? new AudioSampleSource({
        codec: 'aac',
        bitrate: job.audioBitrate,
        onEncoderConfig: (config) => {
          audioCodec = config.codec
        },
      })
    : null
  if (audio) output.addAudioTrack(audio)

  // Cancelling closes the file stream; the caller removes the file once this returns.
  let canceling: Promise<void> | null = null
  const cancel = () => (canceling ??= output.cancel().catch(() => undefined))
  const onAbort = () => void cancel()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await output.start()
    let audioSent = 0
    const sendAudioUntil = async (t: Seconds) => {
      if (!audio || !mix) return
      while (audioSent < Math.min(duration, t)) {
        const seconds = Math.min(1, duration - audioSent)
        const sample = audioSlice(mix, audioSent, seconds)
        if (!sample) break
        await audio.add(sample)
        sample.close()
        audioSent += seconds
      }
    }
    const timeLeft = exportTimeLeft(frameCount, job.expected)
    const started = performance.now()
    for (let i = 0; i < frameCount; i++) {
      throwIfCancelled()
      const t = i / fps
      // Keep audio about a second ahead of video so the muxer can interleave without buffering much.
      await sendAudioUntil(t + 1)
      await drawer.draw(i)
      await video.add(t, 1 / fps)
      if (i % 5 === 0 || i === frameCount - 1) {
        ctx.progress({
          stage: 'render',
          fraction: 0.02 + (0.96 * (i + 1)) / frameCount,
          message: `Rendering frame ${i + 1} of ${frameCount}`,
          // Undefined clears an earlier figure: progress updates are merged.
          etaSeconds: timeLeft(i + 1, (performance.now() - started) / 1000),
        })
      }
    }
    await sendAudioUntil(duration)
    throwIfCancelled()
    video.close()
    audio?.close()
    ctx.progress({ stage: 'finalize', message: 'Finishing the file', fraction: 0.99 })
    await output.finalize()
    return { frameCount, videoCodec, audioCodec }
  } catch (error) {
    if (output.state !== 'finalized') await cancel()
    throw ctx.signal.aborted
      ? new JobError('cancelled', 'Export cancelled', { cause: error })
      : toJobError(error)
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    drawer.dispose()
  }
}

/** A trial render of some of an export's frames, to time it on this device before it runs (export.ts probeExport). */
export interface ProbeJob extends FrameJob {
  videoBitrate: number
  /** Runs of consecutive output frame indices, in increasing order. */
  windows: number[][]
}

export interface ProbeWindow {
  /** The window's first frame index. */
  first: number
  /** Time to draw and encode the window's first frame, which seeks the decoders (and in the first window, warms up). */
  firstMs: number
  /** Time for the rest of the window, and the compositor renders they took. */
  ms: number
  renders: number
  /** Each of those frames' times. */
  frameMs: number[]
}

export interface ExportProbe {
  /** Until the encoder was ready for the first frame. */
  setupMs: number
  windows: ProbeWindow[]
  /** Encoding what was still queued after the last frame. */
  flushMs: number
}

/**
 * Draws and encodes `job.windows` as an export would, into a discarded file, and times it. The encoder sees the
 * windows back to back, so it works as hard per frame as in the export.
 */
export async function measureExport(
  job: ProbeJob,
  ctx: { readonly signal: AbortSignal },
  options: { media: MediaFileSource; registry?: PluginRegistry },
): Promise<ExportProbe> {
  const throwIfCancelled = () => {
    if (ctx.signal.aborted) throw new JobError('cancelled', 'Cancelled')
  }
  const started = performance.now()
  const drawer = frameDrawer(job, options)
  const output = new Output({ format: new Mp4OutputFormat(), target: new NullTarget() })
  try {
    const video = new CanvasSource(drawer.canvas, {
      codec: 'avc',
      bitrate: job.videoBitrate,
      keyFrameInterval: 2,
      latencyMode: 'quality',
    })
    output.addVideoTrack(video, { frameRate: job.fps })
    await output.start()
    const setupMs = performance.now() - started
    const windows: ProbeWindow[] = []
    let n = 0
    for (const frames of job.windows) {
      const window: ProbeWindow = { first: frames[0] ?? 0, firstMs: 0, ms: 0, renders: 0, frameMs: [] }
      for (const [k, i] of frames.entries()) {
        throwIfCancelled()
        const t0 = performance.now()
        await drawer.draw(i)
        await video.add(n / job.fps, 1 / job.fps)
        n++
        const ms = performance.now() - t0
        if (k === 0) window.firstMs = ms
        else {
          window.ms += ms
          window.renders += drawer.renders(i)
          window.frameMs.push(ms)
        }
      }
      windows.push(window)
    }
    throwIfCancelled()
    const flushStarted = performance.now()
    video.close()
    await output.finalize()
    return { setupMs, windows, flushMs: performance.now() - flushStarted }
  } catch (error) {
    if (output.state !== 'finalized') await output.cancel().catch(() => undefined)
    throw ctx.signal.aborted ? new JobError('cancelled', 'Cancelled', { cause: error }) : toJobError(error)
  } finally {
    drawer.dispose()
  }
}
