/**
 * Audio mixing shared by playback and export. scheduleMix() puts every audible clip on a live AudioContext (preview)
 * or an OfflineAudioContext (export mixdown) with the same timing and gain curves, so export sounds like preview.
 */
import {
  STEM_NAMES,
  type Animatable,
  type Asset,
  type Id,
  type Project,
  type Seconds,
  type StemName,
  type Track,
} from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { evaluate } from './animation.ts'
import type { MediaFileSource } from './types.ts'

/** One audible source: an audio clip, one separated stem of an audio clip, or the soundtrack of a video clip. */
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
  /** Set when this plays one stem of the clip (its track mutes or solos stems); `assetId` is then the stem's asset. */
  stem?: StemName
}

export interface AudibleClipOptions {
  /** false: ignore stem mute and solo, as if none were set (the plain mix). Default true. */
  stems?: boolean
}

/** The separated stems of an asset whose assets are in the project. */
function separatedStems(project: Project, assetId: Id): [StemName, Id][] {
  const stems = project.analysis.audio[assetId]?.stems
  if (!stems) return []
  return STEM_NAMES.flatMap((name): [StemName, Id][] => {
    const id = stems[name]
    return id && project.assets[id] ? [[name, id]] : []
  })
}

interface StemFlags {
  solo: StemName[]
  muted: StemName[]
}

function stemFlags(track: Track): StemFlags | null {
  const stems = track.kind === 'audio' ? track.stems : undefined
  if (!stems) return null
  const solo = STEM_NAMES.filter((name) => stems[name]?.solo)
  const muted = STEM_NAMES.filter((name) => stems[name]?.muted)
  return solo.length > 0 || muted.length > 0 ? { solo, muted } : null
}

/**
 * Clips that are heard, honoring clip and track mute and solo. Any solo (of an audio track or of a stem) silences the
 * other audio tracks and the sound of video clips. On a track that mutes or solos stems, each audio clip whose asset
 * has separated stems plays as one clip per audible stem with the same timing: the soloed stems (all when none is
 * soloed) minus the muted ones. A soloed stem solos its track, but only where the track has a clip with stems.
 */
export function audibleClips(project: Project, options: AudibleClipOptions = {}): AudibleClip[] {
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const stemTracks = new Map<Id, StemFlags>()
  if (options.stems !== false) {
    for (const clip of Object.values(project.clips)) {
      if (clip.type !== 'audio' || !clip.enabled || stemTracks.has(clip.trackId)) continue
      const track = tracks.get(clip.trackId)
      const flags = track && stemFlags(track)
      if (flags && separatedStems(project, clip.assetId).length > 0) stemTracks.set(clip.trackId, flags)
    }
  }
  const soloed = (t: Track) => t.kind === 'audio' && (t.solo || (stemTracks.get(t.id)?.solo.length ?? 0) > 0)
  const audioSolo = project.tracks.some(soloed)
  const out: AudibleClip[] = []
  for (const clip of Object.values(project.clips)) {
    const track = tracks.get(clip.trackId)
    if (!clip.enabled || !track || track.muted) continue
    if (clip.type === 'audio') {
      if (clip.muted || (audioSolo && !soloed(track))) continue
      const audible: AudibleClip = {
        clipId: clip.id,
        assetId: clip.assetId,
        start: clip.start,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        playbackRate: clip.playbackRate,
        volume: clip.volume,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
      }
      const flags = stemTracks.get(track.id)
      const stems = flags ? separatedStems(project, clip.assetId) : []
      if (!flags || stems.length === 0) {
        out.push(audible)
        continue
      }
      for (const [name, assetId] of stems) {
        if (flags.muted.includes(name) || (flags.solo.length > 0 && !flags.solo.includes(name))) continue
        // The clock keys scheduled sources by clipId, so each stem needs its own.
        out.push({ ...audible, clipId: `${clip.id}:stem:${name}`, assetId, stem: name })
      }
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
  /** Stops every source now, or at context time `at`. */
  stop(at?: number): void
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
    stop(at) {
      for (const node of nodes) {
        if (at !== undefined) {
          node.onended = () => node.disconnect()
          node.stop(at)
          continue
        }
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

/** Decodes encoded audio at a sample rate. */
export type AudioDecodeFunction = (data: ArrayBuffer, sampleRate: number) => Promise<AudioBuffer>

const decodeWithWebAudio: AudioDecodeFunction = (data, sampleRate) =>
  new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(data)

/** Why an asset's audio could not be loaded. Browsers report a failed buffer allocation as a RangeError. */
export function audioLoadError(asset: Pick<Asset, 'name'>, error: unknown): JobError {
  if (error instanceof JobError) return error
  if (error instanceof RangeError)
    return new JobError('out-of-memory', `There is not enough memory to load the audio of “${asset.name}”.`, {
      retryable: true,
      cause: error,
    })
  return new JobError('decode', `The audio of “${asset.name}” couldn’t be decoded.`, { cause: error })
}

interface CacheEntry {
  asset: Asset
  buffer: Promise<AudioBuffer | null>
}

/** Decoded audio per asset, at the asset's own sample rate (playback contexts resample as needed). */
export class AudioBufferCache {
  private readonly entries = new Map<Id, CacheEntry>()
  private readonly ready = new Map<Id, AudioBuffer>()
  private readonly failures = new Map<Id, JobError>()
  /** The assets each playback clock on this cache plays or is about to, so another clock never evicts them. */
  private readonly holds = new Map<object, ReadonlySet<Id>>()
  private readonly media: MediaFileSource
  private readonly decode: AudioDecodeFunction

  constructor(media: MediaFileSource, options: { decode?: AudioDecodeFunction } = {}) {
    this.media = media
    this.decode = options.decode ?? decodeWithWebAudio
  }

  /**
   * The asset's decoded audio, or null when it cannot be decoded (see error()). A failure is remembered, so the asset
   * is not decoded again unless `retry` is set.
   */
  get(asset: Asset, options: { retry?: boolean } = {}): Promise<AudioBuffer | null> {
    const existing = this.entries.get(asset.id)
    if (existing && !(options.retry && this.failures.has(asset.id))) return existing.buffer
    this.failures.delete(asset.id)
    const entry: CacheEntry = { asset, buffer: Promise.resolve(null) }
    // An entry evicted while decoding must not come back when its decode finishes.
    const current = () => this.entries.get(asset.id) === entry
    entry.buffer = this.media
      .getFile(asset)
      .then(async (file) => this.decode(await file.arrayBuffer(), asset.sampleRate ?? 48_000))
      .then(
        (decoded) => {
          if (current()) this.ready.set(asset.id, decoded)
          return decoded
        },
        (error: unknown) => {
          const failure = audioLoadError(asset, error)
          console.warn(failure.message, error)
          if (current()) this.failures.set(asset.id, failure)
          return null
        },
      )
    this.entries.set(asset.id, entry)
    return entry.buffer
  }

  /**
   * Decodes every asset the clips need. Resolves with the buffers of those assets that decoded: a snapshot, so a later
   * evict() or clear() cannot take buffers away from a render using it.
   */
  async load(
    project: Project,
    clips: readonly AudibleClip[],
    options: { retry?: boolean } = {},
  ): Promise<ReadonlyMap<Id, AudioBuffer>> {
    const buffers = new Map<Id, AudioBuffer>()
    await Promise.all(
      [...new Set(clips.map((c) => c.assetId))].map(async (id) => {
        const asset = project.assets[id]
        const buffer = asset ? await this.get(asset, options) : null
        if (buffer) buffers.set(id, buffer)
      }),
    )
    return buffers
  }

  /** Buffers decoded so far. */
  get loaded(): ReadonlyMap<Id, AudioBuffer> {
    return this.ready
  }

  /** Why the asset's audio could not be decoded, if its last decode failed. */
  error(assetId: Id): JobError | undefined {
    return this.failures.get(assetId)
  }

  /** Records the assets `holder` plays or is about to play; null when it plays nothing anymore. */
  hold(holder: object, ids: ReadonlySet<Id> | null): void {
    if (ids) this.holds.set(holder, ids)
    else this.holds.delete(holder)
  }

  /** Whether a holder other than `except` plays the asset or is about to. */
  heldElsewhere(id: Id, except: object): boolean {
    for (const [holder, ids] of this.holds) if (holder !== except && ids.has(id)) return true
    return false
  }

  /** Forgets the assets that match, decoded, decoding or failed. */
  evict(predicate: (asset: Asset) => boolean): void {
    for (const [id, entry] of this.entries) {
      if (!predicate(entry.asset)) continue
      this.entries.delete(id)
      this.ready.delete(id)
      this.failures.delete(id)
    }
  }

  clear(): void {
    this.entries.clear()
    this.ready.clear()
    this.failures.clear()
  }
}

const sharedCaches = new WeakMap<MediaFileSource, AudioBufferCache>()

/**
 * The buffer cache of a media source, shared by playback and export, so an export does not decode again what the
 * preview holds (a separated stem of a 3.5-minute song is about 80 MB decoded).
 */
export function audioBufferCache(media: MediaFileSource): AudioBufferCache {
  let cache = sharedCaches.get(media)
  if (!cache) {
    cache = new AudioBufferCache(media)
    sharedCaches.set(media, cache)
  }
  return cache
}

function stemExportError(cause: JobError | undefined): JobError {
  const memory = cause?.code === 'out-of-memory'
  return new JobError(
    memory ? 'out-of-memory' : 'decode',
    memory
      ? 'The stems couldn’t be loaded for the export: not enough memory. Unmute and unsolo the stems, or try again after closing other tabs.'
      : 'The stems couldn’t be loaded for the export: a stem file couldn’t be decoded. Unmute and unsolo the stems, or separate the stems again.',
    { retryable: memory, cause },
  )
}

/**
 * Renders the project's mix for [range.start, range.end) offline, e.g. for export. Assets whose last decode failed
 * are tried again. A stem that cannot be decoded fails the render (JobError 'out-of-memory' or 'decode') rather than
 * changing what is heard; other assets that cannot be decoded are left out.
 */
export async function renderMix(
  project: Project,
  cache: AudioBufferCache,
  range: { start: Seconds; end: Seconds },
  sampleRate = 48_000,
  channels = 2,
): Promise<AudioBuffer> {
  const clips = audibleClips(project)
  const buffers = await cache.load(project, clips, { retry: true })
  const missingStem = clips.find((c) => c.stem !== undefined && !buffers.has(c.assetId))
  if (missingStem) throw stemExportError(cache.error(missingStem.assetId))
  const length = Math.max(1, Math.ceil((range.end - range.start) * sampleRate))
  const ctx = new OfflineAudioContext(channels, length, sampleRate)
  scheduleMix(ctx, ctx.destination, clips, buffers, range.start, 0, range.end)
  return ctx.startRendering()
}
