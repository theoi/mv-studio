/**
 * Playback clock driven by Web Audio: the song plays through an AudioContext and the timeline time is derived from
 * the time of the sample currently leaving the speakers, so the picture follows what the user hears.
 */
import { projectDuration } from '../model/queries.ts'
import type { Project, Seconds } from '../model/types.ts'
import { audibleClips, AudioBufferCache, scheduleMix, type AudibleClip, type ScheduledMix } from './audio.ts'
import type { MediaFileSource, PlaybackClock, PlaybackState } from './types.ts'

/** Audio is scheduled this far ahead so every source starts exactly on time. */
const LOOKAHEAD = 0.06
const TICK_MS = 25

/** Identifies what playback depends on, so unrelated edits do not restart audio. */
function audioSignature(clips: readonly AudibleClip[]): string {
  return JSON.stringify(clips)
}

export class WebAudioPlaybackClock implements PlaybackClock {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers: AudioBufferCache
  private project: Project | null = null
  private clips: AudibleClip[] = []
  private signature = ''
  private mix: ScheduledMix | null = null
  private playState: PlaybackState = 'stopped'
  /** Timeline time while not playing. */
  private position = 0
  /** While playing: timeline time `anchorTime` is heard at context time `anchorContext`. */
  private anchorContext = 0
  private anchorTime = 0
  /** The next loop pass, scheduled ahead so playback wraps without a gap. */
  private nextPass: { context: number; time: Seconds; mix: ScheduledMix } | null = null
  private loop: { start: Seconds; end: Seconds } | null = null
  private volume = 1
  private ticker: ReturnType<typeof setInterval> | null = null
  private playRequest = 0
  private readonly listeners = new Set<(state: PlaybackState, time: Seconds) => void>()

  constructor(media: MediaFileSource) {
    this.buffers = new AudioBufferCache(media)
  }

  get state(): PlaybackState {
    return this.playState
  }

  get duration(): Seconds {
    return this.project ? projectDuration(this.project) : 0
  }

  /** Updates the project. Audio is rescheduled only when the audible clips changed. */
  setProject(project: Project): void {
    this.project = project
    const clips = audibleClips(project)
    const signature = audioSignature(clips)
    if (signature === this.signature) return
    this.clips = clips
    this.signature = signature
    void this.buffers.load(project, clips).then(() => {
      if (this.playState === 'playing' && this.project === project) this.reschedule(this.currentTime())
    })
    if (this.playState === 'playing') this.reschedule(this.currentTime())
  }

  /** The context's time of the sample now reaching the output device. */
  private heardContextTime(): number {
    const ctx = this.ctx
    if (!ctx) return 0
    const stamp = ctx.getOutputTimestamp?.()
    if (stamp?.contextTime && stamp.performanceTime) {
      const t = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000
      return Math.min(t, ctx.currentTime)
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0)
  }

  currentTime(): Seconds {
    if (this.playState !== 'playing') return this.position
    const heard = this.heardContextTime()
    const next = this.nextPass
    if (next && heard >= next.context) return next.time + (heard - next.context)
    return this.anchorTime + Math.max(0, heard - this.anchorContext)
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /** Starts playback; call from a user gesture (browsers block audio otherwise). Waits for audio to decode. */
  async play(): Promise<void> {
    if (this.playState === 'playing') return
    const request = ++this.playRequest
    const ctx = this.ensureContext()
    const resumed = ctx.resume()
    if (this.project) await this.buffers.load(this.project, this.clips)
    await resumed
    if (request !== this.playRequest) return
    const duration = this.duration
    if (this.loop && (this.position < this.loop.start || this.position >= this.loop.end))
      this.position = this.loop.start
    else if (duration > 0 && this.position >= duration - 1e-3) this.position = 0
    this.playState = 'playing'
    this.reschedule(this.position)
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    this.emit()
  }

  pause(): void {
    this.playRequest++
    if (this.playState !== 'playing') return
    this.position = this.currentTime()
    this.stopAudio()
    this.playState = 'paused'
    this.emit()
  }

  seek(time: Seconds): void {
    const duration = this.duration
    const t = Math.max(0, duration > 0 ? Math.min(time, duration) : time)
    if (this.playState === 'playing') this.reschedule(t)
    else {
      this.position = t
      if (this.playState === 'stopped') this.playState = 'paused'
    }
    this.emit()
  }

  setLoop(range: { start: Seconds; end: Seconds } | null): void {
    this.loop = range && range.end > range.start ? range : null
    if (this.playState !== 'playing') return
    const t = this.currentTime()
    const outside = this.loop && (t < this.loop.start || t >= this.loop.end)
    this.reschedule(outside && this.loop ? this.loop.start : t)
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, volume)
    if (this.master) this.master.gain.value = this.volume
  }

  subscribe(listener: (state: PlaybackState, time: Seconds) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private reschedule(time: Seconds): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    this.mix?.stop()
    this.dropNextPass()
    const when = ctx.currentTime + LOOKAHEAD
    const until = this.loop ? this.loop.end : Infinity
    this.mix = scheduleMix(ctx, master, this.clips, this.buffers.loaded, time, when, until)
    // currentTime() compares this against the heard (output) time, so the picture waits out the device latency.
    this.anchorContext = when
    this.anchorTime = time
  }

  private dropNextPass(): void {
    this.nextPass?.mix.stop()
    this.nextPass = null
  }

  private tick(): void {
    if (this.playState !== 'playing') return
    const ctx = this.ctx
    const master = this.master
    const loop = this.loop
    if (loop && ctx && master) {
      const endContext = this.anchorContext + (loop.end - this.anchorTime)
      if (!this.nextPass && ctx.currentTime + LOOKAHEAD >= endContext && endContext > ctx.currentTime) {
        const mix = scheduleMix(
          ctx,
          master,
          this.clips,
          this.buffers.loaded,
          loop.start,
          endContext,
          loop.end,
        )
        this.nextPass = { context: endContext, time: loop.start, mix }
      }
      const next = this.nextPass
      if (next && this.heardContextTime() >= next.context) {
        this.mix?.stop()
        this.mix = next.mix
        this.anchorContext = next.context
        this.anchorTime = next.time
        this.nextPass = null
        this.emit()
        return
      }
    }
    const t = this.currentTime()
    if (loop && t >= loop.end && !this.nextPass) {
      // The tick ran too late to schedule the next pass ahead (e.g. a throttled background tab).
      this.reschedule(loop.start)
      this.emit()
      return
    }
    const duration = this.duration
    if (t >= duration) {
      this.position = duration
      this.stopAudio()
      this.playState = 'paused'
      this.emit()
    }
  }

  private stopAudio(): void {
    this.mix?.stop()
    this.mix = null
    this.dropNextPass()
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
  }

  private emit(): void {
    const t = this.currentTime()
    for (const listener of this.listeners) listener(this.playState, t)
  }

  dispose(): void {
    this.stopAudio()
    this.playState = 'stopped'
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.buffers.clear()
    this.listeners.clear()
  }
}
