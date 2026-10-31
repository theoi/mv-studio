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
 */
import { projectDuration } from '../model/queries.ts'
import type { Asset, Project, Seconds, VideoClip } from '../model/types.ts'
import { WebGLCompositor } from './compositor.ts'
import { VideoElementFrameProvider } from './frames.ts'
import { planFrame } from './layout.ts'
import { WebAudioPlaybackClock } from './playback.ts'
import { AdaptiveScale, QUALITY_SCALES, type PreviewQuality } from './quality.ts'
import type { MediaFileSource, PlaybackState, PluginRegistry } from './types.ts'

export type { PreviewQuality } from './quality.ts'

export interface PreviewOptions {
  canvas: HTMLCanvasElement
  media: MediaFileSource
  registry?: PluginRegistry
  /** Keep the last frame readable (frame capture, tests). */
  preserveDrawingBuffer?: boolean
}

/** Changes on play, pause, seek, loop, quality and project length changes (not on every frame). */
export interface PreviewSnapshot {
  state: PlaybackState
  time: Seconds
  duration: Seconds
  quality: PreviewQuality
  /** Current render resolution relative to full (1 when paused; below 1 while playback runs at reduced quality). */
  scale: number
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
}

/** Video clips starting within this many seconds get their media element loaded and seeked ahead of time. */
const LOOKAHEAD = 1.5
const WARM_EVERY_MS = 200

export class PreviewController {
  readonly canvas: HTMLCanvasElement
  readonly clock: WebAudioPlaybackClock
  private readonly compositor: WebGLCompositor
  private readonly frames: VideoElementFrameProvider
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
    this.compositor = new WebGLCompositor({
      canvas: options.canvas,
      frames: this.frames,
      media: options.media,
      registry: options.registry,
      preserveDrawingBuffer: options.preserveDrawingBuffer,
    })
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
    return { fps: recent.length, renderMs, dropped: this.dropped, scale: this.scale }
  }

  /** Resolves once the current state (project, time, size) is on screen at its settled quality. */
  async rendered(): Promise<void> {
    for (;;) {
      if (this.inFlight) await this.inFlight
      else if (this.stillPending && !this.raf) this.requestStill()
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
    }
    const s = this.snapshot
    if (
      s.state === next.state &&
      s.time === next.time &&
      s.duration === next.duration &&
      s.quality === next.quality &&
      s.scale === next.scale
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
      if (this.inFlight || this.compositor.gpuBusy()) {
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
    const run = this.compositor
      .render(project, time, { size: this.frameSize(project) })
      .then(
        () => {
          const now = performance.now()
          this.frameLog.push({ at: now, ms: now - started })
          while (this.frameLog.length > 0 && now - (this.frameLog[0] as { at: number }).at > 1000)
            this.frameLog.shift()
          for (const listener of this.frameListeners) listener(time)
        },
        (error: unknown) => console.error('Preview render failed', error),
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
    this.stopLoop()
    this.unsubscribeClock()
    this.clock.dispose()
    this.compositor.dispose()
    this.frames.dispose()
    this.listeners.clear()
    this.frameListeners.clear()
  }
}
