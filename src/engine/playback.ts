/**
 * Playback clock driven by Web Audio: the song plays through an AudioContext and the timeline time is derived from
 * the time of the sample currently leaving the speakers, so the picture follows what the user hears.
 */
import { projectDuration } from '../model/queries.ts'
import type { Id, Project, Seconds } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import {
  audibleClips,
  audioBufferCache,
  type AudioBufferCache,
  scheduleMix,
  type AudibleClip,
  type ScheduledMix,
} from './audio.ts'
import type { MediaFileSource, PlaybackClock, PlaybackState } from './types.ts'

/** Audio is scheduled this far ahead so every source starts exactly on time. */
const LOOKAHEAD = 0.06
const TICK_MS = 25
/**
 * A stem nobody hears stays decoded this long, so switching back to it soon after (A/B between solos) is instant, while
 * a long session gets the memory back (a separated stem of a 5-minute song is about 115 MB decoded).
 */
export const STEM_RELEASE_MS = 60_000

/** Identifies what playback depends on, so unrelated edits do not restart audio. */
function audioSignature(clips: readonly AudibleClip[]): string {
  return JSON.stringify(clips)
}

export class WebAudioPlaybackClock implements PlaybackClock {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly buffers: AudioBufferCache
  private project: Project | null = null
  /** What the project asks to hear. */
  private wanted: AudibleClip[] = []
  private wantedSignature = ''
  /** The project's mix without stem mute and solo. */
  private plain: AudibleClip[] = []
  private plainSignature = ''
  private loadRequest = 0
  /** What is scheduled: `wanted` once its stems are decoded, the mix before them until then. */
  private clips: AudibleClip[] = []
  /** `plainSignature` when `clips` was chosen, to tell whether the project changed beyond stem flags since. */
  private clipsPlain = ''
  /** The scheduled clips and which of their buffers were decoded, to reschedule only when that changes. */
  private scheduledKey = ''
  private readonly reported = new WeakSet<JobError>()
  private readonly errorListeners = new Set<(error: JobError) => void>()
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
  private level = 1
  private ticker: ReturnType<typeof setInterval> | null = null
  private playRequest = 0
  private readonly listeners = new Set<(state: PlaybackState, time: Seconds) => void>()
  /** Release timers of the stems no clip hears (STEM_RELEASE_MS). */
  private readonly releases = new Map<Id, ReturnType<typeof setTimeout>>()

  constructor(media: MediaFileSource) {
    this.buffers = audioBufferCache(media)
  }

  get state(): PlaybackState {
    return this.playState
  }

  get duration(): Seconds {
    return this.project ? projectDuration(this.project) : 0
  }

  /** The clips scheduled now. While newly needed stems decode, the mix that was playing before. */
  get scheduledClips(): readonly AudibleClip[] {
    return this.clips
  }

  /**
   * Updates the project. Audio is rescheduled only when the audible clips changed. When stems are muted or soloed and
   * not decoded yet, the current mix keeps playing until they are, then switches at the current time.
   */
  setProject(project: Project): void {
    this.project = project
    const wanted = audibleClips(project)
    const stems = wanted.some((c) => c.stem !== undefined)
    const plain = stems ? audibleClips(project, { stems: false }) : wanted
    // With stems, the plain mix plays while they decode and when they cannot be, so its changes matter too.
    const plainSignature = audioSignature(plain)
    const signature = audioSignature(wanted) + (stems ? plainSignature : '')
    if (signature === this.wantedSignature) return
    this.wanted = wanted
    this.plain = plain
    this.plainSignature = plainSignature
    this.wantedSignature = signature
    this.holdBuffers()
    // The cache is shared by every clock and export on this media source, so it is never cleared, only trimmed to
    // what this project can play, keeping what another clock plays. A stem that could not be decoded is forgotten
    // once no stem is heard, so it is decoded again the next time (the app's stem failures follow this); decoded
    // stems go STEM_RELEASE_MS after they were last heard.
    const used = new Set(wanted.map((c) => c.assetId))
    this.buffers.evict(
      (asset) =>
        !this.buffers.heldElsewhere(asset.id, this) &&
        (!project.assets[asset.id] ||
          (!stems && asset.origin.type === 'stem' && !used.has(asset.id) && !!this.buffers.error(asset.id))),
    )
    this.timeReleases(project, used)
    const request = ++this.loadRequest
    for (const id of new Set([...wanted, ...plain].map((c) => c.assetId))) {
      const asset = project.assets[id]
      if (!asset || this.buffers.loaded.has(id)) continue
      void this.buffers.get(asset).then(() => {
        if (request === this.loadRequest) this.refresh()
      })
    }
    this.refresh()
  }

  /** Starts the release timer of each stem no clip hears, and stops it for the stems heard again. */
  private timeReleases(project: Project, used: ReadonlySet<Id>): void {
    for (const [id, timer] of this.releases) {
      if (!used.has(id) && project.assets[id]) continue
      clearTimeout(timer)
      this.releases.delete(id)
    }
    for (const asset of Object.values(project.assets))
      if (asset.origin.type === 'stem' && !used.has(asset.id) && !this.releases.has(asset.id))
        this.timeRelease(asset.id)
  }

  private timeRelease(id: Id): void {
    this.releases.set(
      id,
      setTimeout(() => this.release(id), STEM_RELEASE_MS),
    )
  }

  /**
   * Drops a stem's decoded audio, unless it still plays here (the mix that plays while newly heard stems decode) or in
   * another clock on the same cache, whose stem flags may differ (a preview holding an older copy of the project).
   */
  private release(id: Id): void {
    this.releases.delete(id)
    if (this.wanted.some((c) => c.assetId === id)) return
    if (this.clips.some((c) => c.assetId === id) || this.buffers.heldElsewhere(id, this)) {
      this.timeRelease(id)
      return
    }
    // A failure stays: it holds no memory, and the app keeps showing it while some stem is heard.
    if (!this.buffers.error(id)) this.buffers.evict((asset) => asset.id === id)
  }

  /**
   * Reports audio that cannot play: stems that could not be decoded ('out-of-memory' or 'decode', with
   * `details.assetId`). The full mix plays instead.
   */
  onAudioError(listener: (error: JobError) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Tells the shared cache what this clock plays or is about to: the wanted mix, its fallback and what is scheduled. */
  private holdBuffers(): void {
    this.buffers.hold(this, new Set([...this.wanted, ...this.plain, ...this.clips].map((c) => c.assetId)))
  }

  /** Chooses what to schedule from the decoded buffers, and reschedules while playing when that changed. */
  private refresh(): void {
    const project = this.project
    if (!project) return
    const loaded = this.buffers.loaded
    let clips = this.wanted
    const pending = clips.filter((c) => c.stem !== undefined && !loaded.has(c.assetId))
    if (pending.length > 0) {
      const failed = pending.find((c) => this.buffers.error(c.assetId))
      const failure = failed && this.buffers.error(failed.assetId)
      if (failed && failure) this.report(failure, failed.assetId)
      else if (
        this.clips.length > 0 &&
        this.clipsPlain === this.plainSignature &&
        this.clips.every((c) => loaded.has(c.assetId))
      )
        // Stems that already play (another solo, say) keep playing until the newly needed ones are decoded.
        return
      clips = this.plain
    }
    const key = `${audioSignature(clips)}|${clips.map((c) => loaded.has(c.assetId)).join()}`
    if (key === this.scheduledKey) return
    this.clips = clips
    this.holdBuffers()
    this.clipsPlain = this.plainSignature
    this.scheduledKey = key
    this.switchMix()
  }

  private report(failure: JobError, assetId: string): void {
    if (this.reported.has(failure)) return
    this.reported.add(failure)
    const memory = failure.code === 'out-of-memory'
    const error = new JobError(
      memory ? 'out-of-memory' : 'decode',
      memory ? 'There is not enough memory to play the stems separately.' : 'A stem could not be decoded.',
      { retryable: memory, cause: failure, details: { assetId } },
    )
    for (const listener of this.errorListeners) listener(error)
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
      this.master.gain.value = this.level
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /**
   * Starts playback; call from a user gesture (browsers block audio otherwise). Waits for the song to decode, but not
   * for stems: until they are decoded the plain mix plays, then it switches to them on the same sample.
   */
  async play(): Promise<void> {
    if (this.playState === 'playing') return
    const request = ++this.playRequest
    const ctx = this.ensureContext()
    const resumed = ctx.resume()
    if (this.project) await this.buffers.load(this.project, this.plain)
    await resumed
    if (request !== this.playRequest) return
    this.refresh()
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

  /** The output gain set with setVolume (1 = as mixed). */
  get volume(): number {
    return this.level
  }

  setVolume(volume: number): void {
    this.level = Math.max(0, volume)
    if (this.master) this.master.gain.value = this.level
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

  /**
   * Replaces the playing mix with the scheduled clips without a gap or a jump: the new sources start where the old
   * ones stop, on the same sample.
   */
  private switchMix(): void {
    const ctx = this.ctx
    const master = this.master
    if (this.playState !== 'playing' || !ctx || !master) return
    const when = ctx.currentTime + LOOKAHEAD
    const time = this.anchorTime + (when - this.anchorContext)
    const until = this.loop ? this.loop.end : Infinity
    if (this.nextPass || time >= until) {
      this.reschedule(this.currentTime())
      return
    }
    this.mix?.stop(when)
    this.mix = scheduleMix(ctx, master, this.clips, this.buffers.loaded, time, when, until)
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
    for (const timer of this.releases.values()) clearTimeout(timer)
    this.releases.clear()
    this.buffers.hold(this, null)
    this.stopAudio()
    this.playState = 'stopped'
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.listeners.clear()
    this.errorListeners.clear()
  }
}
