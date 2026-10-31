/**
 * Audio mixing shared by playback and export. scheduleMix() puts every audible clip on a live AudioContext (preview)
 * or an OfflineAudioContext (export mixdown) with the same timing and gain curves, so export sounds like preview.
 */
import type { Animatable, Asset, Id, Project, Seconds } from '../model/types.ts'
import { evaluate } from './animation.ts'
import type { MediaFileSource } from './types.ts'

/** One audible source: an audio clip, or the soundtrack of a video clip. */
export interface AudibleClip {
  clipId: Id
  assetId: Id
  start: Seconds
  duration: Seconds
  sourceStart: Seconds
  playbackRate: number
  volume: Animatable
  fadeIn: Seconds
  fadeOut: Seconds
}

/**
 * Clips that are heard, honoring clip and track mute. Soloing an audio track silences the other audio tracks and the
 * sound of video clips.
 */
export function audibleClips(project: Project): AudibleClip[] {
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const audioSolo = project.tracks.some((t) => t.kind === 'audio' && t.solo)
  const out: AudibleClip[] = []
  for (const clip of Object.values(project.clips)) {
    const track = tracks.get(clip.trackId)
    if (!clip.enabled || !track || track.muted) continue
    if (clip.type === 'audio') {
      if (clip.muted || (audioSolo && !track.solo)) continue
      out.push({
        clipId: clip.id,
        assetId: clip.assetId,
        start: clip.start,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        playbackRate: clip.playbackRate,
        volume: clip.volume,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
      })
    } else if (clip.type === 'video') {
      if (clip.muted || audioSolo || track.hidden || project.assets[clip.assetId]?.hasAudio === false)
        continue
      out.push({
        clipId: clip.id,
        assetId: clip.assetId,
        start: clip.start,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        playbackRate: clip.playbackRate,
        volume: clip.volume,
        fadeIn: 0,
        fadeOut: 0,
      })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Gain at clip-local time: keyframed volume times the fade-in/out ramps. */
export function clipGain(clip: AudibleClip, local: Seconds): number {
  let gain = Math.max(0, evaluate(clip.volume, local))
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= Math.max(0, local / clip.fadeIn)
  const remaining = clip.duration - local
  if (clip.fadeOut > 0 && remaining < clip.fadeOut) gain *= Math.max(0, remaining / clip.fadeOut)
  return gain
}

const GAIN_CURVE_RATE = 100

/** Gain samples from `from` to the clip end at GAIN_CURVE_RATE per second, or a constant when nothing changes. */
export function gainCurve(clip: AudibleClip, from: Seconds): number | Float32Array {
  const animated = (clip.volume.keyframes?.length ?? 0) > 1 || clip.fadeIn > 0 || clip.fadeOut > 0
  if (!animated) return clipGain(clip, from)
  const span = clip.duration - from
  const n = Math.max(2, Math.ceil(span * GAIN_CURVE_RATE) + 1)
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) curve[i] = clipGain(clip, from + (span * i) / (n - 1))
  return curve
}

export interface ScheduledMix {
  stop(): void
}

/**
 * Schedules the project's audio from timeline time `from`, heard at context time `when`. Clips whose buffers are not
 * in `buffers` are skipped.
 */
export function scheduleMix(
  ctx: BaseAudioContext,
  destination: AudioNode,
  clips: readonly AudibleClip[],
  buffers: ReadonlyMap<Id, AudioBuffer>,
  from: Seconds,
  when: number,
  until: Seconds = Infinity,
): ScheduledMix {
  const nodes: AudioBufferSourceNode[] = []
  for (const clip of clips) {
    const buffer = buffers.get(clip.assetId)
    const end = Math.min(clip.start + clip.duration, until)
    if (!buffer || end <= from || clip.start >= until || clip.playbackRate <= 0) continue
    const local = Math.max(0, from - clip.start)
    const offset = clip.sourceStart + local * clip.playbackRate
    if (offset >= buffer.duration) continue
    const startAt = when + Math.max(0, clip.start - from)
    const playFor = end - Math.max(from, clip.start)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = clip.playbackRate
    const gain = ctx.createGain()
    const curve = gainCurve(clip, local)
    if (typeof curve === 'number') gain.gain.value = curve
    else {
      gain.gain.value = curve[0] as number
      gain.gain.setValueCurveAtTime(curve, startAt, Math.max(clip.duration - local, 1e-3))
    }
    source.connect(gain).connect(destination)
    source.start(startAt, offset, playFor * clip.playbackRate)
    nodes.push(source)
  }
  return {
    stop() {
      for (const node of nodes) {
        try {
          node.stop()
        } catch {
          // Already stopped.
        }
        node.disconnect()
      }
      nodes.length = 0
    },
  }
}

/** Decoded audio per asset, at the asset's own sample rate (playback contexts resample as needed). */
export class AudioBufferCache {
  private readonly buffers = new Map<Id, Promise<AudioBuffer | null>>()
  private readonly ready = new Map<Id, AudioBuffer>()
  private readonly media: MediaFileSource

  constructor(media: MediaFileSource) {
    this.media = media
  }

  get(asset: Asset): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(asset.id)
    if (!buffer) {
      buffer = this.media
        .getFile(asset)
        .then(async (file) => {
          const ctx = new OfflineAudioContext(1, 1, asset.sampleRate ?? 48_000)
          const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
          this.ready.set(asset.id, decoded)
          return decoded
        })
        .catch((error: unknown) => {
          console.warn(`Audio of "${asset.name}" could not be decoded`, error)
          return null
        })
      this.buffers.set(asset.id, buffer)
    }
    return buffer
  }

  /** Decodes every asset the clips need; resolves with the buffers available. */
  async load(project: Project, clips: readonly AudibleClip[]): Promise<ReadonlyMap<Id, AudioBuffer>> {
    const ids = new Set(clips.map((c) => c.assetId))
    await Promise.all(
      [...ids].map((id) => {
        const asset = project.assets[id]
        return asset ? this.get(asset) : null
      }),
    )
    return this.ready
  }

  /** Buffers decoded so far. */
  get loaded(): ReadonlyMap<Id, AudioBuffer> {
    return this.ready
  }

  clear(): void {
    this.buffers.clear()
    this.ready.clear()
  }
}

/** Renders the project's mix for [range.start, range.end) offline, e.g. for export. */
export async function renderMix(
  project: Project,
  cache: AudioBufferCache,
  range: { start: Seconds; end: Seconds },
  sampleRate = 48_000,
  channels = 2,
): Promise<AudioBuffer> {
  const clips = audibleClips(project)
  const buffers = await cache.load(project, clips)
  const length = Math.max(1, Math.ceil((range.end - range.start) * sampleRate))
  const ctx = new OfflineAudioContext(channels, length, sampleRate)
  scheduleMix(ctx, ctx.destination, clips, buffers, range.start, 0, range.end)
  return ctx.startRendering()
}
