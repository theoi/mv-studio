/**
 * Preview controller for the UI. Owns the preview canvas, the compositor and the Web Audio clock, and draws the
 * project at the playback time on every animation frame while playing, or once per change while paused.
 *
 *   const preview = new PreviewController({ canvas, media: mediaStore })
 *   preview.setProject(editor.getProject())
 *   editor.subscribe((project) => preview.setProject(project))
 *   const { state, time } = useSyncExternalStore(preview.subscribe, preview.getSnapshot)
 *   playButton.onclick = () => preview.toggle()          // from a user gesture, so audio may start
 *   new ResizeObserver(([e]) => preview.setViewport(e.contentRect.width, e.contentRect.height)).observe(box)
 *   preview.onFrame((time) => { playhead.style.left = ... })   // per rendered frame, without React renders
 */
import { projectDuration } from '../model/queries.ts'
import type { Project, Seconds } from '../model/types.ts'
import { WebGLCompositor } from './compositor.ts'
import { VideoElementFrameProvider } from './frames.ts'
import { WebAudioPlaybackClock } from './playback.ts'
import type { MediaFileSource, PlaybackState, PluginRegistry } from './types.ts'

export interface PreviewOptions {
  canvas: HTMLCanvasElement
  media: MediaFileSource
  registry?: PluginRegistry
  /** Keep the last frame readable (frame capture, tests). */
  preserveDrawingBuffer?: boolean
}

/** Changes on play, pause, seek, loop and project length changes (not on every frame). */
export interface PreviewSnapshot {
  state: PlaybackState
  time: Seconds
  duration: Seconds
}

export interface PreviewStats {
  /** Frames drawn over the last second. */
  fps: number
  /** Mean render time over the last second, in milliseconds. */
  renderMs: number
  /** Animation frames skipped because the previous frame was still rendering. */
  dropped: number
}

export class PreviewController {
  readonly canvas: HTMLCanvasElement
  readonly clock: WebAudioPlaybackClock
  private readonly compositor: WebGLCompositor
  private readonly frames: VideoElementFrameProvider
  private project: Project | null = null
  private raf = 0
  private inFlight: Promise<void> | null = null
  private stillPending = false
  private viewport: { width: number; height: number; dpr: number } | null = null
  private snapshot: PreviewSnapshot = { state: 'stopped', time: 0, duration: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly frameListeners = new Set<(time: Seconds) => void>()
  private readonly frameLog: { at: number; ms: number }[] = []
  private dropped = 0
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
      if (state === 'playing') this.startLoop()
      else {
        this.stopLoop()
        this.requestStill()
      }
      this.updateSnapshot()
    })
  }

  setProject(project: Project): void {
    const sizeChanged =
      !this.project ||
      this.project.settings.width !== project.settings.width ||
      this.project.settings.height !== project.settings.height
    this.project = project
    this.clock.setProject(project)
    if (sizeChanged) this.applySize()
    this.updateSnapshot()
    this.requestStill()
  }

  /** The preview box in CSS pixels; the canvas renders at that size times devicePixelRatio, capped at project size. */
  setViewport(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1): void {
    this.viewport = { width: cssWidth, height: cssHeight, dpr }
    this.applySize()
    this.requestStill()
  }

  private applySize(): void {
    if (!this.project) return
    const { width, height } = this.project.settings
    let scale = 1
    if (this.viewport && this.viewport.width > 0 && this.viewport.height > 0) {
      const fit = Math.min(this.viewport.width / width, this.viewport.height / height) * this.viewport.dpr
      scale = Math.min(1, fit)
    }
    this.compositor.resize(Math.round(width * scale), Math.round(height * scale))
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
    this.clock.setLoop(range)
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
    return { fps: recent.length, renderMs, dropped: this.dropped }
  }

  /** Resolves once the current state (project, time, size) is on screen. */
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
    }
    const s = this.snapshot
    if (s.state === next.state && s.time === next.time && s.duration === next.duration) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private startLoop(): void {
    if (this.raf) return
    this.stillPending = false
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.inFlight) {
        this.dropped++
        return
      }
      void this.draw(this.clock.currentTime())
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
      .render(project, time)
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
