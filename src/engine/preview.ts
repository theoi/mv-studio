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
 * playback resolution too, and lowers it the same way. Once paused and settled, frames always render at full
 * resolution.
 *
 * Frames are drawn on this thread or, with renderer 'worker' (see PREVIEW_IN_WORKER), in the render worker: the canvas
 * moves there and is drawn by the same compositor as export, while this thread keeps the audio clock and the <video>
 * elements and hands the worker each frame's video frames. Drawing then never blocks input, however slow the GPU.
 * Read pixels with captureFrame(), which works in both cases.
 */
import { LAST_FRAME_LEAD, projectDuration } from '../model/queries.ts'
import type { Asset, Project, Seconds, VideoClip } from '../model/types.ts'
import type { JobError, SerializedJobError } from '../shared/jobs.ts'
import { createAudioSampler, type AudioSampler } from './audioFeatures.ts'
import { videoRequests, visibleLayers, WebGLCompositor } from './compositor.ts'
import { VideoElementFrameProvider, type BridgedVideo } from './frames.ts'
import { planFrame } from './layout.ts'
import { WebAudioPlaybackClock } from './playback.ts'
import { analysisPatches, type AnalysisPatch, type PreviewRenderRequest } from './previewWorker.ts'
import { AdaptiveScale, QUALITY_SCALES, scrubScale, stillLevel, type PreviewQuality } from './quality.ts'
import { startPreviewWorker, type PreviewWorker } from './renderHost.ts'
import type { FrameRef, MediaFileSource, PlaybackState, PluginRegistry } from './types.ts'

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

/** A playback frame, a still, or a still during a scrub. */
type FrameKind = 'playback' | 'still' | 'scrub'

/** Draws preview frames, on this thread or in the render worker. */
interface FrameRenderer {
  readonly inWorker: boolean
  /**
   * A still on the main thread finishes only once the GPU has drawn it, not when it is queued; the worker waits for its
   * first frame only. `onDrawn` gets how long a still took to draw, once known: on the main thread as it finishes,
   * media waits included (its compositor makes them itself); on the worker some time after, timed there from the start
   * of its rendering to the GPU finishing, for stills outside a scrub other than the first frame (which also starts the
   * worker).
   */
  draw(
    project: Project,
    time: Seconds,
    size: Size,
    kind?: FrameKind,
    onDrawn?: (ms: number) => void,
  ): Promise<void>
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

  async draw(
    project: Project,
    time: Seconds,
    size: Size,
    kind: FrameKind = 'playback',
    onDrawn?: (ms: number) => void,
  ): Promise<void> {
    const started = performance.now()
    await this.compositor.render(project, time, { size })
    // More GL calls while the GPU is busy would block this thread until it caught up. A still finishes only when it
    // is drawn, so stills that arrive meanwhile wait and coalesce, and its draw time is the frame's real cost.
    // Playback frames don't wait: polling the fence is coarser than a display frame, and the loop checks busy().
    if (kind === 'playback') return
    await this.compositor.gpuIdle()
    onDrawn?.(performance.now() - started)
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

/** Versions of frames sent to the render worker ahead of their request: negative, unlike presented-frame serials. */
let stagedSerial = 0

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
  private drawn = false

  constructor(worker: PreviewWorker, frames: VideoElementFrameProvider) {
    this.worker = worker
    this.frames = frames
  }

  async draw(
    project: Project,
    time: Seconds,
    size: Size,
    kind: FrameKind = 'playback',
    onDrawn?: (ms: number) => void,
  ): Promise<void> {
    // Only the first still waits for the GPU: until it is drawn the page canvas is blank, while later stills replace
    // a frame already on screen, and waiting for each would slow drags (the next request would no longer overlap the
    // GPU work). A still outside a scrub is timed in the worker instead, and its time fetched once known.
    const first = !this.drawn
    const measure = onDrawn !== undefined && kind === 'still' && !first
    await this.request(project, time, size, false, kind !== 'playback' && first, measure)
    this.drawn = true
    if (measure)
      void this.worker.drawnMs().then((ms) => {
        if (ms !== null) onDrawn(ms)
      })
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

  /**
   * What changed since the last request: the top-level fields, and the analysis as patches. Unchanged values (most of
   * the analysis, usually) are not copied to the worker again.
   */
  private projectChanges(project: Project): Pick<PreviewRenderRequest, 'project' | 'analysis'> {
    const sent = this.sentProject
    if (sent === project) return {}
    this.sentProject = project
    if (!sent) return { project }
    const changes: Record<string, unknown> = {}
    let analysis: AnalysisPatch[] | undefined
    for (const key of new Set([...Object.keys(sent), ...Object.keys(project)]) as Set<keyof Project>) {
      if (project[key] === sent[key]) continue
      if (key === 'analysis') analysis = analysisPatches(sent.analysis, project.analysis)
      else changes[key] = project[key]
    }
    return { project: changes as Partial<Project>, analysis }
  }

  private async request(
    project: Project,
    time: Seconds,
    size: Size,
    capture: boolean,
    untilDrawn = false,
    measure = false,
  ): Promise<ImageBitmap | null> {
    const plan = visibleLayers(planFrame(project, time), project, time, size, this.sampler(project))
    const requests = videoRequests(project, plan, time)
    this.frames.beginFrame(requests.map((r) => r.key))
    // A seek's frame goes to the worker as soon as the seek ends, to be uploaded while slower seeks finish. The render
    // follows once every frame is there and names the staged ones, so it draws with exactly these frames.
    const staged = new Map<string, BridgedVideo>()
    const stage = (key: string, ref: FrameRef | null) => {
      if (requests.length < 2 || !ref || ref.version !== undefined) return
      const frame = toVideoFrame(ref.source)
      if (!frame) return
      const video = { key, frame, width: ref.width, height: ref.height, version: -++stagedSerial }
      this.worker.stage(video)
      staged.set(key, { ...video, frame: null, staged: true })
    }
    const refs = await Promise.all(
      requests.map((r) =>
        this.frames.videoFrame(r.asset, r.time, r.key, r.rate).then(
          (ref) => {
            stage(r.key, ref)
            return ref
          },
          () => null,
        ),
      ),
    )
    const videos: BridgedVideo[] = []
    const transfer: VideoFrame[] = []
    const keys = new Set<string>()
    requests.forEach(({ key }, i) => {
      keys.add(key)
      const ahead = staged.get(key)
      if (ahead) {
        this.sentVersions.set(key, ahead.version)
        videos.push(ahead)
        return
      }
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
        { time, size, ...this.projectChanges(project), videos, capture, untilDrawn, measure },
        transfer,
      )
    } catch (error) {
      // A stopped worker rejects without taking the frames; close them (a no-op for frames it took).
      for (const frame of transfer) frame.close()
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

/** On the main-thread renderer, a still requested within this long of the last one's end is a drag step. */
const SCRUB_GAP_MS = 50
/** A drag on the main-thread renderer settles at full resolution after this long without a new still. */
const SCRUB_SETTLE_MS = 150

/** Video clips starting within this many seconds get their media element loaded and seeked ahead of time. */
const LOOKAHEAD = 1.5
/** While paused, the clips of the transitions this close to the playhead (the nearest few) keep an element loaded. */
const PREWARM_RANGE = 2
const PREWARM_TRANSITIONS = 2
const WARM_EVERY_MS = 200
/** How long dispose() waits for frames being drawn or captured before it stops the renderer anyway. */
const DISPOSE_WAIT_MS = 2000

/**
 * The time a frame is drawn at. Every clip has ended at the project's end itself, so a playhead there (where playback
 * stops) shows the last frame instead of an empty one.
 */
function shownTime(project: Project, time: Seconds): Seconds {
  const duration = projectDuration(project)
  return duration > 0 ? Math.min(time, Math.max(0, duration - LAST_FRAME_LEAD)) : time
}

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
  /**
   * When the last still finished drawing, and how long the last two full-size ones took to draw (FrameRenderer.draw),
   * for the current project and frame size. The faster counts: the other may have paid a one-off cost, a shader
   * compiled on first use or an image loaded. On the main thread that time includes media waits (a seek), so a drag
   * right after one can draw smaller than needed; the drag's settle frame measures again.
   */
  private lastStillEnd = -Infinity
  private fullStills: number[] = []
  /** Set while a scrub on the main-thread renderer waits to settle at full resolution. */
  private settleTimer: ReturnType<typeof setTimeout> | undefined
  private viewport: { width: number; height: number; dpr: number } | null = null
  private quality: PreviewQuality = 'auto'
  private readonly auto = new AdaptiveScale()
  /** The project and full-size frame auto quality last measured, as `checkAutoBasis()` writes it. */
  private autoBasis = ''
  private scale = 1
  private snapshot: PreviewSnapshot = { state: 'stopped', time: 0, duration: 0, quality: 'auto', scale: 1 }
  private readonly listeners = new Set<() => void>()
  private readonly frameListeners = new Set<(time: Seconds) => void>()
  /**
   * Seeks so far, loop changes that move the playhead included: while playing, a frame drawn for the time before one is
   * not reported to frame listeners.
   */
  private seeks = 0
  private readonly frameLog: { at: number; ms: number }[] = []
  private dropped = 0
  private loop: { start: Seconds; end: Seconds } | null = null
  private warmedAt = 0
  /** captureFrame() calls not yet resolved: dispose() lets them finish, so a preview can be captured as it closes. */
  private readonly captures = new Set<Promise<ImageBitmap>>()
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
        this.frames.prewarm([])
        this.scrubbing = false
        this.cancelSettle()
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
          console.warn('The preview worker couldn’t start; drawing on the main thread', error)
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
    this.checkAutoBasis()
    this.updateSnapshot()
    this.requestStill()
  }

  /** The preview box in CSS pixels; the canvas renders at that size times devicePixelRatio, capped at project size. */
  setViewport(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1): void {
    this.viewport = { width: cssWidth, height: cssHeight, dpr }
    this.checkAutoBasis()
    this.requestStill()
  }

  /**
   * What auto quality learned (its limits and retry waits) holds for one full-size frame and one project: when either
   * changes during playback or a scrub, it judges afresh. Other edits, which arrive on every change, keep it.
   */
  private checkAutoBasis(): void {
    const project = this.project
    if (!project) return
    const { width, height } = this.frameSize(project, 1)
    const basis = `${project.id} ${width}x${height}`
    if (basis === this.autoBasis) return
    this.autoBasis = basis
    this.fullStills = []
    if (this.clock.state === 'playing' || this.scrubbing) this.auto.start(performance.now())
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
    if (this.clock.state === 'playing') this.scale = this.playbackScale()
    else this.scale = this.scrubbing ? this.scrubbingScale() : 1
  }

  private scrubbingScale(): number {
    const scale = this.playbackScale()
    // The main-thread renderer blocks while it draws, so a slow still slows the drag itself: draw smaller to keep up.
    const full = this.fullStillMs()
    if (this.quality !== 'auto' || this.renderer?.inWorker !== false || !full) return scale
    return Math.min(scale, scrubScale(full))
  }

  /** How long a full-size still takes to draw (see fullStills), or 0 before one has been measured. */
  private fullStillMs(): number {
    return this.fullStills.length ? Math.min(...this.fullStills) : 0
  }

  /** Canvas size for the next frame: the viewport (times DPR, capped at project size) times the current scale. */
  private frameSize(project: Project, scale = this.scale): { width: number; height: number } {
    const { width, height } = project.settings
    let fit = 1
    if (this.viewport && this.viewport.width > 0 && this.viewport.height > 0) {
      fit = Math.min(
        1,
        Math.min(this.viewport.width / width, this.viewport.height / height) * this.viewport.dpr,
      )
    }
    const s = fit * scale
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
    this.seeks++
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
    const t = this.clock.currentTime()
    // While playing, a range the playhead is outside of moves it to the range's start (see the clock), as a seek does.
    if (
      this.clock.state === 'playing' &&
      range &&
      range.end > range.start &&
      (t < range.start || t >= range.end)
    )
      this.seeks++
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

  /**
   * While paused, has the frame provider keep elements ready for the clips that the nearest transitions show besides
   * the clips on screen at `time`. Each is seeked to where the transition is nearest to the playhead.
   */
  private prewarmTransitions(time: Seconds): void {
    const project = this.project
    if (!project) return
    const spans: { at: Seconds; distance: number }[] = []
    for (const clip of Object.values(project.clips)) {
      if (clip.type === 'audio' || !clip.enabled) continue
      const end = clip.start + clip.duration
      const tin = clip.transitionIn?.duration ?? 0
      const tout = clip.transitionOut?.duration ?? 0
      for (const [from, to] of [
        [clip.start, clip.start + tin],
        [end - tout, end],
      ] as const) {
        if (to <= from) continue
        const at = Math.min(Math.max(time, from), to - 1e-3)
        const distance = Math.abs(at - time)
        if (distance <= PREWARM_RANGE) spans.push({ at, distance })
      }
    }
    spans.sort((a, b) => a.distance - b.distance)
    const shown = new Set(videoRequests(project, planFrame(project, time), time).map((r) => r.key))
    const requests: Parameters<VideoElementFrameProvider['prewarm']>[0] = []
    for (const { at } of spans.slice(0, PREWARM_TRANSITIONS))
      for (const r of videoRequests(project, planFrame(project, at), at))
        if (!shown.has(r.key) && !requests.some((q) => q.key === r.key))
          requests.push({ asset: r.asset, sourceTime: r.time, key: r.key })
    this.frames.prewarm(requests)
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

  /**
   * Called after each rendered frame with its timeline time. While playing, a frame asked for before the latest seek is
   * not reported: it shows where the playhead was, and the frame of the new position follows. While paused every frame
   * is reported, a scrub's included.
   */
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
  captureFrame(): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(new Error('The preview is closed'))
    const capture = this.capture()
    this.captures.add(capture)
    const done = () => this.captures.delete(capture)
    capture.then(done, done)
    return capture
  }

  private async capture(): Promise<ImageBitmap> {
    const renderer = await this.rendererReady
    if (this.preserveDrawingBuffer) return renderer.capture()
    await this.rendered()
    const project = this.project
    if (!project) throw new Error('The preview has no project')
    return renderer.snapshot(project, shownTime(project, this.clock.currentTime()), this.frameSize(project))
  }

  /**
   * Resolves once the current state (project, time, size) is on screen at its settled quality. Rejects when the
   * preview can no longer draw (snapshot `error`).
   */
  async rendered(): Promise<void> {
    for (;;) {
      if (this.inFlight) await this.inFlight
      else if (this.stillPending && !this.raf) this.requestStill()
      else if (this.settleTimer !== undefined) this.settle()
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
    if (this.disposed) {
      this.stillPending = false
      return
    }
    if (this.failure) {
      this.stillPending = false
      return
    }
    if (this.raf || !this.project) return
    if (this.inFlight) {
      this.stillPending = true
      this.startScrub()
      return
    }
    // On the main-thread renderer a still right after the last one is a drag step too, and the drag settles only after
    // a pause: a full-size frame between two steps would hold up the next one.
    if (this.renderer?.inWorker === false && performance.now() - this.lastStillEnd < SCRUB_GAP_MS) {
      this.startScrub()
      this.cancelSettle()
      this.settleTimer = setTimeout(() => this.settle(), SCRUB_SETTLE_MS)
    }
    // A scrub's stills step the resolution down like playback frames, but only a still that waited for the one before
    // it measures how fast stills are drawn: the others waited for the pointer.
    if (this.scrubbing && this.quality === 'auto') {
      const now = performance.now()
      if (!this.stillPending) this.auto.skip(now)
      else if (this.auto.frame(now)) this.updateScale()
    }
    this.stillPending = false
    void this.draw(this.clock.currentTime(), true)
    this.updateSnapshot()
  }

  /** Stills arrive faster than they are drawn: a scrub, judged from its own stills (the level carries over). */
  private startScrub(): void {
    if (this.scrubbing) return
    this.scrubbing = true
    // On the worker, a scrub starts no sharper than full-size stills draw in time for: with slow stills, judging its
    // own would take seconds. On the main thread, scrubbingScale() caps the scale instead.
    const full = this.fullStillMs()
    const atLeast = this.quality === 'auto' && this.renderer?.inWorker && full ? stillLevel(full) : 0
    this.auto.start(performance.now(), atLeast)
    this.updateScale()
  }

  private cancelSettle(): void {
    clearTimeout(this.settleTimer)
    this.settleTimer = undefined
  }

  /** Ends a scrub: the frame is drawn again at full resolution. */
  private settle(): void {
    this.cancelSettle()
    // A draw in flight settles when it ends.
    if (!this.scrubbing || this.raf || this.inFlight) return
    this.scrubbing = false
    this.updateScale()
    // Not a drag step, however soon after the last still: this one draws at full resolution.
    this.lastStillEnd = -Infinity
    this.requestStill()
  }

  private draw(requested: Seconds, still = false): Promise<void> {
    const project = this.project
    if (!project || this.disposed) return Promise.resolve()
    const time = shownTime(project, requested)
    const started = performance.now()
    const size = this.frameSize(project)
    const scale = this.scale
    const renderer = this.renderer
    const kind: FrameKind = !still ? 'playback' : this.scrubbing ? 'scrub' : 'still'
    const basis = this.autoBasis
    const seeks = this.seeks
    // The worker's time arrives after the frame: one for another project or frame size no longer counts.
    const onDrawn =
      still && scale === 1
        ? (ms: number) => {
            if (this.autoBasis === basis) this.fullStills = [...this.fullStills.slice(-1), ms]
          }
        : undefined
    const run = (
      renderer
        ? renderer.draw(project, time, size, kind, onDrawn)
        : this.rendererReady.then((r) => r.draw(project, time, size, kind, onDrawn))
    )
      .then(
        () => {
          this.lastSize = size
          const now = performance.now()
          this.frameLog.push({ at: now, ms: now - started })
          if (still) this.lastStillEnd = now
          // After the frame, so the clips it shows are not taken for ones to keep ready. A drag waits until it settles.
          if (still && !this.scrubbing && this.clock.state !== 'playing') this.prewarmTransitions(time)
          while (this.frameLog.length > 0 && now - (this.frameLog[0] as { at: number }).at > 1000)
            this.frameLog.shift()
          if (seeks === this.seeks || this.clock.state !== 'playing')
            for (const listener of this.frameListeners) listener(requested)
        },
        (error: unknown) => {
          if (this.disposed) return
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
        // Caught up, unless a scrub on the main-thread renderer waits for more steps.
        else if (this.settleTimer === undefined) this.settle()
      })
    this.inFlight = run
    return run
  }

  dispose(): void {
    this.disposed = true
    this.cancelSettle()
    this.stopLoop()
    this.unsubscribeClock()
    this.clock.dispose()
    this.listeners.clear()
    this.frameListeners.clear()
    // Frames being drawn or captured finish first: stopping the worker mid-render drops the video frames it was sent,
    // unclosed. A renderer that is alive but stuck (render calls have no timeout once it has drawn) is stopped anyway.
    const release = () => {
      this.renderer?.dispose()
      this.frames.dispose()
    }
    const busy = [...this.captures, ...(this.inFlight ? [this.inFlight] : [])]
    if (busy.length === 0) {
      release()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise((resolve) => {
      timer = setTimeout(resolve, DISPOSE_WAIT_MS)
    })
    void Promise.race([Promise.allSettled(busy), waited]).then(() => {
      clearTimeout(timer)
      release()
    })
  }
}
