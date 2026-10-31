/**
 * Preview controller for the UI. Owns the preview canvas, the compositor and the Web Audio clock, and draws the
 * project at the playback time on every animation frame while playing, or once per change while paused.
 *
 *   const preview = new PreviewController({ canvas, media: mediaStore })
 *   preview.setProject(editor.getProject())
 *   editor.subscribe((project) => preview.setProject(project))
 *   const { state, time, quality, scale } = useSyncExternalStore(preview.subscribe, preview.getSnapshot)
 *   playButton.onclick = () => preview.toggle()          // from a user gesture, so audio may start
 *   new ResizeObserver(([e]) => preview.setViewport(e.contentRect.width, e.contentRect.height)).observe(box)
 *   preview.onFrame((time) => { playhead.style.left = ... })   // per rendered frame, without React renders
 *   qualityMenu.onchange = (q) => preview.setQuality(q)   // 'auto' | 'full' | 'half' | 'quarter'
 *
 * The audio clock is the master: frames that cannot be drawn in time are skipped, never slowing the clock. While
 * playing, the preview never queues a frame on a busy GPU (that would block the main thread and the UI), and with
 * quality 'auto' it lowers the render resolution when frames come too slowly. Scrubbing that cannot keep up uses the
 * playback resolution too. Once paused and settled, frames always render at full resolution.
 *
 * Frames are drawn on this thread or, with renderer 'worker' (see PREVIEW_IN_WORKER), in the render worker: the canvas
 * moves there and is drawn by the same compositor as export, while this thread keeps the audio clock and the <video>
 * elements and hands the worker each frame's video frames. Drawing then never blocks input, however slow the GPU.
 * Read pixels with captureFrame(), which works in both cases.
 */
import { projectDuration } from '../model/queries.ts'
import type { Asset, Project, Seconds, VideoClip } from '../model/types.ts'
import type { JobError, SerializedJobError } from '../shared/jobs.ts'
import { createAudioSampler, type AudioSampler } from './audioFeatures.ts'
import { videoRequests, visibleLayers, WebGLCompositor } from './compositor.ts'
import { VideoElementFrameProvider, type BridgedVideo } from './frames.ts'
import { planFrame } from './layout.ts'
import { WebAudioPlaybackClock } from './playback.ts'
import { AdaptiveScale, QUALITY_SCALES, type PreviewQuality } from './quality.ts'
import { startPreviewWorker, type PreviewWorker } from './renderHost.ts'
import type { MediaFileSource, PlaybackState, PluginRegistry } from './types.ts'

export type { PreviewQuality } from './quality.ts'

export interface PreviewOptions {
  canvas: HTMLCanvasElement
  media: MediaFileSource
  registry?: PluginRegistry
  /** Keep the last frame readable: captureFrame() then returns the frame drawn last instead of drawing again. */
  preserveDrawingBuffer?: boolean
  /**
   * Where frames are drawn: 'worker' moves the canvas to the render worker, 'main' draws on this thread. Defaults to
   * the PREVIEW_IN_WORKER switch. The worker is used only when the browser supports it and no custom registry is
   * given, and the preview falls back to the main thread when the worker cannot start.
   */
  renderer?: 'worker' | 'main'
}

/** Changes on play, pause, seek, loop, quality and project length changes (not on every frame). */
export interface PreviewSnapshot {
  state: PlaybackState
  time: Seconds
  duration: Seconds
  quality: PreviewQuality
  /** Current render resolution relative to full (1 when paused; below 1 while playback runs at reduced quality). */
  scale: number
  /**
   * Set once the preview can no longer draw: its render worker died ('worker-crashed', 'out-of-memory') or, while
   * starting, failed or stopped answering ('timeout'), taking the canvas with it. A new preview on a new canvas draws
   * again.
   */
  error?: SerializedJobError
}

export interface PreviewStats {
  /** Frames drawn over the last second. */
  fps: number
  /** Mean main-thread time to issue a frame over the last second, in milliseconds. */
  renderMs: number
  /** Animation frames skipped because the previous frame was still rendering (on the CPU or the GPU). */
  dropped: number
  /** Render resolution relative to full. */
  scale: number
  /** Size of the frame drawn last, in pixels. */
  width: number
  height: number
  /** Whether frames are drawn in the render worker. */
  worker: boolean
}

/**
 * Draws previews in the render worker unless a preview asks otherwise (PreviewOptions.renderer). The URL parameter
 * `preview-worker=0` (or `1`) overrides it for a page load, e.g. to compare with the main-thread path.
 */
const PREVIEW_IN_WORKER = true

function defaultRenderer(): 'worker' | 'main' {
  const param =
    typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('preview-worker')
  if (param === '1') return 'worker'
  if (param === '0') return 'main'
  return PREVIEW_IN_WORKER ? 'worker' : 'main'
}

interface Size {
  width: number
  height: number
}

/** Draws preview frames, on this thread or in the render worker. */
interface FrameRenderer {
  readonly inWorker: boolean
  draw(project: Project, time: Seconds, size: Size): Promise<void>
  /** The GPU is still drawing the last frame, so drawing another now would block the main thread. */
  busy(): boolean
  /** Draws a frame and returns it. */
  snapshot(project: Project, time: Seconds, size: Size): Promise<ImageBitmap>
  /** The frame drawn last; needs preserveDrawingBuffer. */
  capture(): Promise<ImageBitmap>
  /** Why this renderer can no longer draw at all, or null. */
  failure(): JobError | null
  dispose(): void
}

class MainRenderer implements FrameRenderer {
  readonly inWorker = false
  private readonly compositor: WebGLCompositor

  constructor(compositor: WebGLCompositor) {
    this.compositor = compositor
  }

  draw(project: Project, time: Seconds, size: Size): Promise<void> {
    return this.compositor.render(project, time, { size })
  }

  busy(): boolean {
    return this.compositor.gpuBusy()
  }

  snapshot(project: Project, time: Seconds, size: Size): Promise<ImageBitmap> {
    // Chained directly on the render, in the drawing's task: the drawing buffer is cleared once the task ends.
    return this.compositor
      .render(project, time, { size })
      .then(() => createImageBitmap(this.compositor.canvas))
  }

  capture(): Promise<ImageBitmap> {
    return createImageBitmap(this.compositor.canvas)
  }

  failure(): JobError | null {
    return null
  }

  dispose(): void {
    this.compositor.dispose()
  }
}

function toVideoFrame(source: TexImageSource): VideoFrame | null {
  try {
    if (source instanceof VideoFrame) return source.clone()
    if (source instanceof ImageData) return null
    return new VideoFrame(source, { timestamp: 0 })
  } catch {
    // A <video> without a decoded frame yet.
    return null
  }
}

/**
 * Feeds the render worker: per frame, takes the frames the worker's compositor will request from the <video>
 * elements (the same plan and requests as the compositor computes) and sends them with the project changes.
 */
class WorkerRenderer implements FrameRenderer {
  readonly inWorker = true
  private readonly worker: PreviewWorker
  private readonly frames: VideoElementFrameProvider
  private readonly samplers = new WeakMap<Project, AudioSampler>()
  private sentProject: Project | null = null
  /** Version of the frame last sent per key, so unchanged frames are not sent again. */
  private readonly sentVersions = new Map<string, number | undefined>()

  constructor(worker: PreviewWorker, frames: VideoElementFrameProvider) {
    this.worker = worker
    this.frames = frames
  }

  async draw(project: Project, time: Seconds, size: Size): Promise<void> {
    await this.request(project, time, size, false)
  }

  async snapshot(project: Project, time: Seconds, size: Size): Promise<ImageBitmap> {
    const bitmap = await this.request(project, time, size, true)
    if (!bitmap) throw new Error('The preview worker returned no frame')
    return bitmap
  }

  capture(): Promise<ImageBitmap> {
    return this.worker.capture()
  }

  failure(): JobError | null {
    return this.worker.failure()
  }

  busy(): boolean {
    // The worker waits for its GPU itself; the controller keeps one frame in flight.
    return false
  }

  private sampler(project: Project): AudioSampler {
    let s = this.samplers.get(project)
    if (!s) {
      s = createAudioSampler(project)
      this.samplers.set(project, s)
    }
    return s
  }

  /** Top-level fields that changed since the last request; unchanged ones (analysis, usually) are not copied again. */
  private projectChanges(project: Project): Partial<Project> | undefined {
    const sent = this.sentProject
    if (sent === project) return undefined
    this.sentProject = project
    if (!sent) return project
    const changes: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(sent), ...Object.keys(project)]) as Set<keyof Project>)
      if (project[key] !== sent[key]) changes[key] = project[key]
    return changes as Partial<Project>
  }

  private async request(
    project: Project,
    time: Seconds,
    size: Size,
    capture: boolean,
  ): Promise<ImageBitmap | null> {
    const plan = visibleLayers(planFrame(project, time), project, time, size, this.sampler(project))
    const requests = videoRequests(project, plan, time)
    this.frames.beginFrame(requests.map((r) => r.key))
    const refs = await Promise.all(
      requests.map((r) => this.frames.videoFrame(r.asset, r.time, r.key, r.rate).catch(() => null)),
    )
    const videos: BridgedVideo[] = []
    const transfer: Transferable[] = []
    const keys = new Set<string>()
    requests.forEach(({ key }, i) => {
      keys.add(key)
      const ref = refs[i]
      if (ref && ref.version !== undefined && this.sentVersions.get(key) === ref.version) {
        videos.push({
          key,
          frame: null,
          width: ref.width,
          height: ref.height,
          version: ref.version,
          same: true,
        })
        return
      }
      const frame = ref && toVideoFrame(ref.source)
      if (!ref || !frame) {
        this.sentVersions.delete(key)
        videos.push({ key, frame: null, width: 0, height: 0 })
        return
      }
      transfer.push(frame)
      this.sentVersions.set(key, ref.version)
      videos.push({ key, frame, width: ref.width, height: ref.height, version: ref.version })
    })
    for (const key of this.sentVersions.keys()) if (!keys.has(key)) this.sentVersions.delete(key)
    this.frames.endFrame()
    try {
      return await this.worker.render(
        { time, size, project: this.projectChanges(project), videos, capture },
        transfer,
      )
    } catch (error) {
      // The worker may not have applied this request: send everything again next time.
      this.sentProject = null
      this.sentVersions.clear()
      throw error
    }
  }

  dispose(): void {
    this.worker.dispose()
  }
}

/** Video clips starting within this many seconds get their media element loaded and seeked ahead of time. */
const LOOKAHEAD = 1.5
const WARM_EVERY_MS = 200

export class PreviewController {
  readonly canvas: HTMLCanvasElement
  readonly clock: WebAudioPlaybackClock
  private readonly frames: VideoElementFrameProvider
  /** Null until the render worker has started (or failed to, and the main thread draws instead). */
  private renderer: FrameRenderer | null = null
  private readonly rendererReady: Promise<FrameRenderer>
  private readonly preserveDrawingBuffer: boolean
  private disposed = false
  /** Why the renderer can no longer draw; frames are no longer requested. */
  private failure: JobError | null = null
  private lastSize: Size = { width: 0, height: 0 }
  private project: Project | null = null
  private raf = 0
  private inFlight: Promise<void> | null = null
  private stillPending = false
  /** Paused edits or seeks arrived faster than frames rendered; settles at full resolution afterwards. */
  private scrubbing = false
  private viewport: { width: number; height: number; dpr: number } | null = null
  private quality: PreviewQuality = 'auto'
  private readonly auto = new AdaptiveScale()
  private scale = 1
  private snapshot: PreviewSnapshot = { state: 'stopped', time: 0, duration: 0, quality: 'auto', scale: 1 }
  private readonly listeners = new Set<() => void>()
  private readonly frameListeners = new Set<(time: Seconds) => void>()
  private readonly frameLog: { at: number; ms: number }[] = []
  private dropped = 0
  private loop: { start: Seconds; end: Seconds } | null = null
  private warmedAt = 0
  private readonly unsubscribeClock: () => void

  constructor(options: PreviewOptions) {
    this.canvas = options.canvas
    this.frames = new VideoElementFrameProvider(options.media)
    this.preserveDrawingBuffer = options.preserveDrawingBuffer ?? false
    this.rendererReady = this.createRenderer(options)
    this.clock = new WebAudioPlaybackClock(options.media)
    this.unsubscribeClock = this.clock.subscribe((state) => {
      this.frames.setPlaying(state === 'playing')
      if (state === 'playing') {
        this.scrubbing = false
        this.auto.start(performance.now())
        this.updateScale()
        this.startLoop()
      } else {
        this.stopLoop()
        this.frames.warm([])
        this.updateScale()
        this.requestStill()
      }
      this.updateSnapshot()
    })
  }

  private createRenderer(options: PreviewOptions): Promise<FrameRenderer> {
    const onMainThread = () =>
      new MainRenderer(
        new WebGLCompositor({
          canvas: options.canvas,
          frames: this.frames,
          media: options.media,
          registry: options.registry,
          preserveDrawingBuffer: this.preserveDrawingBuffer,
        }),
      )
    const canUseWorker =
      !options.registry &&
      typeof Worker !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof options.canvas.transferControlToOffscreen === 'function'
    if ((options.renderer ?? defaultRenderer()) !== 'worker' || !canUseWorker) {
      this.renderer = onMainThread()
      return Promise.resolve(this.renderer)
    }
    return startPreviewWorker(options.canvas, options.media, {
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    })
      .then(
        (worker): FrameRenderer => new WorkerRenderer(worker, this.frames),
        (error: unknown) => {
          console.warn('The preview worker could not start; drawing on the main thread', error)
          return onMainThread()
        },
      )
      .then((renderer) => {
        if (this.disposed) renderer.dispose()
        else this.renderer = renderer
        return renderer
      })
  }

  setProject(project: Project): void {
    this.project = project
    this.clock.setProject(project)
    this.updateSnapshot()
    this.requestStill()
  }

  /** The preview box in CSS pixels; the canvas renders at that size times devicePixelRatio, capped at project size. */
  setViewport(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1): void {
    this.viewport = { width: cssWidth, height: cssHeight, dpr }
    this.requestStill()
  }

  /**
   * Playback resolution: 'auto' (default) lowers it while the machine cannot keep up, 'full', 'half' and 'quarter'
   * fix it. Paused frames always render at full resolution.
   */
  setQuality(quality: PreviewQuality): void {
    this.quality = quality
    this.updateScale()
    this.updateSnapshot()
  }

  private playbackScale(): number {
    return this.quality === 'auto' ? this.auto.scale : QUALITY_SCALES[this.quality]
  }

  private updateScale(): void {
    this.scale = this.clock.state === 'playing' || this.scrubbing ? this.playbackScale() : 1
  }

  /** Canvas size for the next frame: the viewport (times DPR, capped at project size) times the current scale. */
  private frameSize(project: Project): { width: number; height: number } {
    const { width, height } = project.settings
    let fit = 1
    if (this.viewport && this.viewport.width > 0 && this.viewport.height > 0) {
      fit = Math.min(
        1,
        Math.min(this.viewport.width / width, this.viewport.height / height) * this.viewport.dpr,
      )
    }
    const s = fit * this.scale
    return { width: Math.max(2, Math.round(width * s)), height: Math.max(2, Math.round(height * s)) }
  }

  play(): Promise<void> {
    return this.clock.play()
  }

  pause(): void {
    this.clock.pause()
  }

  toggle(): Promise<void> {
    if (this.clock.state === 'playing') {
      this.pause()
      return Promise.resolve()
    }
    return this.play()
  }

  seek(time: Seconds): void {
    this.clock.seek(time)
  }

  /** Steps by whole frames at the project frame rate (negative steps go back). */
  step(frames: number): void {
    const fps = this.project?.settings.fps ?? 30
    const frame = Math.round(this.clock.currentTime() * fps) + frames
    this.seek(Math.max(0, frame) / fps)
  }

  setLoop(range: { start: Seconds; end: Seconds } | null): void {
    this.loop = range
    this.clock.setLoop(range)
  }

  /** Keeps media elements loaded for these video assets (e.g. VJ pads), so clips using them start without a stall. */
  prefetch(assets: Asset[]): void {
    this.frames.prefetch(assets.filter((a) => a.kind === 'video'))
  }

  /** Loads and seeks the media of video clips that start within LOOKAHEAD seconds (or right after a loop wrap). */
  private warmUpcoming(now: number, time: Seconds): void {
    const project = this.project
    if (!project || now - this.warmedAt < WARM_EVERY_MS) return
    this.warmedAt = now
    const requests: Parameters<VideoElementFrameProvider['warm']>[0] = []
    const add = (clip: VideoClip, at: Seconds, startsIn: Seconds) => {
      const asset = project.assets[clip.assetId]
      if (!asset) return
      const sourceTime = clip.sourceStart + (at - clip.start) * clip.playbackRate
      requests.push({ asset, sourceTime, key: clip.id, startsIn, rate: clip.playbackRate })
    }
    const shownAt = (at: Seconds) =>
      planFrame(project, at).flatMap((l) => (l.kind === 'transition' ? [l.from, l.to] : [l.clip]))
    const shown = shownAt(time)
    // A clip that continues the footage of a clip on screen takes over that clip's element at the cut instead.
    const continues = (clip: VideoClip) =>
      shown.some(
        (c) =>
          c?.type === 'video' &&
          c.assetId === clip.assetId &&
          c.playbackRate === clip.playbackRate &&
          Math.abs(c.start + c.duration - clip.start) < 1e-3 &&
          Math.abs(c.sourceStart + c.duration * c.playbackRate - clip.sourceStart) < 0.02,
      )
    let horizon = time + LOOKAHEAD
    if (this.loop && horizon > this.loop.end) {
      horizon = this.loop.end
      for (const clip of shownAt(this.loop.start))
        if (clip?.type === 'video') add(clip, this.loop.start, this.loop.end - time)
    }
    for (const clip of Object.values(project.clips)) {
      if (clip.type !== 'video' || !clip.enabled || clip.start <= time || clip.start > horizon) continue
      if (!continues(clip) && shownAt(clip.start + 1e-3).includes(clip))
        add(clip, clip.start, clip.start - time)
    }
    this.frames.warm(requests)
  }
  setVolume(volume: number): void {
    this.clock.setVolume(volume)
  }

  currentTime(): Seconds {
    return this.clock.currentTime()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PreviewSnapshot => this.snapshot

  /** Called after each rendered frame with its timeline time. */
  onFrame(listener: (time: Seconds) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  stats(): PreviewStats {
    const now = performance.now()
    const recent = this.frameLog.filter((f) => now - f.at <= 1000)
    const renderMs = recent.length ? recent.reduce((a, f) => a + f.ms, 0) / recent.length : 0
    return {
      fps: recent.length,
      renderMs,
      dropped: this.dropped,
      scale: this.scale,
      width: this.lastSize.width,
      height: this.lastSize.height,
      worker: this.renderer?.inWorker ?? false,
    }
  }

  /**
   * The preview as an image. With preserveDrawingBuffer, the frame drawn last (await rendered() first for the settled
   * frame); otherwise the current state, drawn again. Use it to read pixels: a canvas moved to the render worker
   * cannot be read on this thread.
   */
  async captureFrame(): Promise<ImageBitmap> {
    const renderer = await this.rendererReady
    if (this.preserveDrawingBuffer) return renderer.capture()
    await this.rendered()
    const project = this.project
    if (!project) throw new Error('The preview has no project')
    return renderer.snapshot(project, this.clock.currentTime(), this.frameSize(project))
  }

  /**
   * Resolves once the current state (project, time, size) is on screen at its settled quality. Rejects when the
   * preview can no longer draw (snapshot `error`).
   */
  async rendered(): Promise<void> {
    for (;;) {
      if (this.inFlight) await this.inFlight
      else if (this.stillPending && !this.raf) this.requestStill()
      else if (this.failure) throw this.failure
      else return
    }
  }

  private updateSnapshot(): void {
    const next: PreviewSnapshot = {
      state: this.clock.state,
      time: this.clock.currentTime(),
      duration: this.project ? projectDuration(this.project) : 0,
      quality: this.quality,
      scale: this.scale,
      ...(this.failure ? { error: this.failure.toJSON() } : {}),
    }
    const s = this.snapshot
    if (
      s.state === next.state &&
      s.time === next.time &&
      s.duration === next.duration &&
      s.quality === next.quality &&
      s.scale === next.scale &&
      s.error?.code === next.error?.code
    )
      return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private startLoop(): void {
    if (this.raf) return
    this.stillPending = false
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      if (this.failure) return
      if (this.inFlight || this.renderer?.busy()) {
        this.dropped++
        return
      }
      if (this.quality === 'auto' && this.auto.frame(now)) {
        this.updateScale()
        this.updateSnapshot()
      }
      const time = this.clock.currentTime()
      void this.draw(time)
      this.warmUpcoming(now, time)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private requestStill(): void {
    if (this.failure) {
      this.stillPending = false
      return
    }
    if (this.raf || !this.project) return
    if (this.inFlight) {
      this.stillPending = true
      if (!this.scrubbing) {
        this.scrubbing = true
        this.updateScale()
      }
      return
    }
    this.stillPending = false
    void this.draw(this.clock.currentTime())
    this.updateSnapshot()
  }

  private draw(time: Seconds): Promise<void> {
    const project = this.project
    if (!project) return Promise.resolve()
    const started = performance.now()
    const size = this.frameSize(project)
    const renderer = this.renderer
    const run = (
      renderer
        ? renderer.draw(project, time, size)
        : this.rendererReady.then((r) => r.draw(project, time, size))
    )
      .then(
        () => {
          this.lastSize = size
          const now = performance.now()
          this.frameLog.push({ at: now, ms: now - started })
          while (this.frameLog.length > 0 && now - (this.frameLog[0] as { at: number }).at > 1000)
            this.frameLog.shift()
          for (const listener of this.frameListeners) listener(time)
        },
        (error: unknown) => {
          const failure = this.renderer?.failure()
          if (!failure) console.error('Preview render failed', error)
          else if (!this.failure) {
            this.failure = failure
            console.error('The preview stopped drawing: its render worker failed', failure)
            this.updateSnapshot()
          }
        },
      )
      .finally(() => {
        this.inFlight = null
        if (this.stillPending) this.requestStill()
        else if (this.scrubbing && !this.raf) {
          // Caught up: draw the settled frame at full resolution.
          this.scrubbing = false
          this.updateScale()
          this.requestStill()
        }
      })
    this.inFlight = run
    return run
  }

  dispose(): void {
    this.disposed = true
    this.stopLoop()
    this.unsubscribeClock()
    this.clock.dispose()
    this.renderer?.dispose()
    this.frames.dispose()
    this.listeners.clear()
    this.frameListeners.clear()
  }
}
