/**
 * Frame providers. Preview uses <video> elements (hardware decoding, real-time playback); export decodes with
 * WebCodecs through mediabunny, which is frame-exact and needs no DOM. Both return the frame whose presentation
 * interval contains the requested source time.
 */
import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny'
import type { Asset, Id, Seconds } from '../model/types.ts'
import type { FrameProvider, FrameRef, MediaFileSource } from './types.ts'

/** Nudges requests off exact frame boundaries so float error never selects the previous frame. */
const BOUNDARY_EPSILON = 1e-4

function clampSourceTime(asset: Asset, t: Seconds): Seconds {
  const end =
    asset.duration !== undefined
      ? asset.duration - (asset.frameRate ? 0.5 / asset.frameRate : 0.01)
      : Infinity
  return Math.max(0, Math.min(t + BOUNDARY_EPSILON, end))
}

/** Decoded still images, shared by both providers. */
class ImageCache {
  private readonly images = new Map<Id, Promise<ImageBitmap | null>>()
  private readonly media: MediaFileSource

  constructor(media: MediaFileSource) {
    this.media = media
  }

  async get(asset: Asset): Promise<FrameRef | null> {
    let bitmap = this.images.get(asset.id)
    if (!bitmap) {
      bitmap = this.media
        .getFile(asset)
        // WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps, so premultiply when decoding.
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }))
        .catch((error: unknown) => {
          console.warn(`Image “${asset.name}” couldn’t be decoded`, error)
          return null
        })
      this.images.set(asset.id, bitmap)
    }
    const b = await bitmap
    return b && { source: b, width: b.width, height: b.height }
  }

  dispose(): void {
    for (const p of this.images.values()) void p.then((b) => b?.close())
    this.images.clear()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Preview: <video> elements

interface VideoSlot {
  video: HTMLVideoElement
  ready: Promise<boolean>
  assetId: Id
  /** The clip (request key) the slot currently serves. */
  clipKey: string
  /** Kept loaded while idle (prefetch). */
  pinned: boolean
  /** Serial of the last frame the video presented (requestVideoFrameCallback), or 0 before the first. */
  presented: number
  /** Media time of that frame. */
  presentedTime: Seconds
  /** When that frame went to the compositor (its presentationTime, on the performance.now() clock). */
  presentedAt: number
  /** When the element was last paused while playing, or -Infinity. */
  pausedAt: number
  /** Latest requested time while paused; queued seeks skip to it. */
  target: Seconds
  seeking: Promise<void>
  lastUsed: number
}

/** Re-seek a playing video only when it drifts this far (in timeline seconds) from the clock. */
const PLAYBACK_DRIFT = 0.12
/** Smaller drift is steered out by speeding the video up or slowing it down, over about this many seconds. */
const DRIFT_CATCH_UP = 0.5
/** Largest relative speed change used for steering. */
const MAX_NUDGE = 0.25
/** HTMLMediaElement.playbackRate range Chrome plays; other rates show exact frames by seeking instead. */
const MIN_MEDIA_RATE = 0.0625
const MAX_MEDIA_RATE = 16
const PAUSE_AFTER_FRAMES = 2
/** warm() starts an upcoming clip's element playing this long before the cut. */
const PREROLL = 0.3
const RELEASE_AFTER_FRAMES = 900
/**
 * Elements no clip on screen uses (and not warmed, prewarmed or pinned) stay loaded for reuse up to this many pixels of
 * footage in all, the most recently used first. A loaded 4K element holds about 200 MB of decoder and frames, so this
 * keeps two of them, or eight 1080p ones.
 */
const IDLE_PIXEL_BUDGET = 2 * 3840 * 2160
/** Longest time between two frames of a video that a seek's frame check allows for, in seconds. */
const MAX_FRAME_SPACING = 1
/** A seek starting this soon (ms) after its element was paused while playing looks at its frame one animation frame late. */
const JUST_PAUSED_MS = 200
/** How long that wait lasts where animation frames don't run (a hidden page), in ms. */
const FRAME_TIMEOUT_MS = 50

/** Unique across slots, so a texture never mistakes a new slot's frame for one it already holds. */
let presentedSerial = 0

function once(target: EventTarget, events: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const done = (name: string) => {
      clearTimeout(timer)
      for (const e of events) target.removeEventListener(e, handlers[e] as EventListener)
      resolve(name)
    }
    const handlers: Record<string, () => void> = {}
    for (const e of events) {
      handlers[e] = () => done(e)
      target.addEventListener(e, handlers[e] as EventListener)
    }
    const timer = setTimeout(() => done('timeout'), timeoutMs)
  })
}

/** Resolves on the next animation frame, or after `timeoutMs` where frames don't run (a hidden page). */
function nextFrame(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * One <video> element per clip on screen. When a new clip starts, it takes over the element of a clip of the same
 * footage that left the screen, so contiguous pieces (splits, beat cuts) continue without a seek and a freeze is a
 * pause; during playback, elements for clips starting soon are loaded and seeked ahead of time (warm()).
 */
export class VideoElementFrameProvider implements FrameProvider {
  private readonly slots = new Map<string, VideoSlot>()
  /** Request keys of the frame being rendered, whose slots must not be taken over. */
  private active = new Set<string>()
  /** Slot ids reserved by warm() for clips about to start. */
  private upcoming = new Set<string>()
  /** Slot ids kept loaded by prewarm() for clips of a transition near the paused playhead. */
  private prewarmed = new Set<string>()
  /** This frame's exact frames by footage and source time, so clips showing the same frame share one seek. */
  private exact = new Map<string, Promise<FrameRef | null>>()
  private readonly urls = new Map<Id, Promise<string>>()
  private readonly images: ImageCache
  private readonly media: MediaFileSource
  private playing = false
  private rate = 1
  private frame = 0

  constructor(media: MediaFileSource) {
    this.media = media
    this.images = new ImageCache(media)
  }

  /**
   * While playing, videos run in real time and are re-seeked only when they drift from the clock, so rendering never
   * waits for a seek. While paused or scrubbing, every request seeks exactly and waits for the frame.
   */
  setPlaying(playing: boolean, rate = 1): void {
    this.playing = playing
    this.rate = rate
    if (!playing) for (const slot of this.slots.values()) this.pause(slot)
  }

  image(asset: Asset): Promise<FrameRef | null> {
    return this.images.get(asset)
  }

  private url(asset: Asset): Promise<string> {
    let url = this.urls.get(asset.id)
    if (!url) {
      url = this.media.getFile(asset).then((file) => URL.createObjectURL(file))
      this.urls.set(asset.id, url)
    }
    return url
  }

  beginFrame(keys: string[]): void {
    this.active = new Set(keys)
    this.exact.clear()
  }

  /** The slot for a clip: its own, a free one of the same footage (nearest to `t`), or a new element. */
  private slot(asset: Asset, key: string, t: Seconds): VideoSlot {
    const id = `${key}:${asset.id}`
    let slot = this.slots.get(id)
    if (slot) return slot
    let free: [string, VideoSlot] | null = null
    for (const entry of this.slots) {
      const [otherId, other] = entry
      if (
        other.assetId !== asset.id ||
        this.active.has(other.clipKey) ||
        this.upcoming.has(otherId) ||
        this.prewarmed.has(otherId)
      )
        continue
      if (!free || Math.abs(other.video.currentTime - t) < Math.abs(free[1].video.currentTime - t))
        free = entry
    }
    if (free) {
      this.slots.delete(free[0])
      free[1].clipKey = key
      this.slots.set(id, free[1])
      return free[1]
    }
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    const ready = this.url(asset).then(async (url) => {
      video.src = url
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true
      const result = await once(video, ['loadeddata', 'error'], 15_000)
      return result === 'loadeddata'
    })
    slot = {
      video,
      ready,
      assetId: asset.id,
      clipKey: key,
      pinned: false,
      presented: 0,
      presentedTime: -1,
      presentedAt: -1,
      pausedAt: -Infinity,
      target: 0,
      seeking: Promise.resolve(),
      lastUsed: this.frame,
    }
    this.slots.set(id, slot)
    if ('requestVideoFrameCallback' in video) {
      const current = slot
      const watch = () =>
        video.requestVideoFrameCallback((_now, metadata) => {
          current.presented = ++presentedSerial
          current.presentedTime = metadata.mediaTime
          current.presentedAt = metadata.presentationTime
          watch()
        })
      watch()
    }
    return slot
  }

  videoFrame(asset: Asset, sourceTime: Seconds, key: string, rate = 1): Promise<FrameRef | null> {
    const t = clampSourceTime(asset, sourceTime)
    const slot = this.slot(asset, key, t)
    slot.lastUsed = this.frame
    const mediaRate = rate * this.rate
    if (this.playing && mediaRate >= MIN_MEDIA_RATE && mediaRate <= MAX_MEDIA_RATE)
      return this.playingFrame(asset, t, slot, mediaRate)
    // Paused, a clip showing the same frame of the same footage as another clip in this frame (a layer and a copy of
    // it, say) takes that clip's frame: one decoder seeks instead of two. The rate doesn't change which frame shows at
    // a source time. The clip keeps its own element, loaded, for when the two part or playback starts.
    const id = `${asset.id}@${t}`
    let frame = this.exact.get(id)
    if (!frame) {
      frame = this.exactFrame(slot, t)
      this.exact.set(id, frame)
    }
    return frame
  }

  /** Paused transport, a freeze (rate 0) or a rate the element cannot play: the exact frame, seeked and waited for. */
  private async exactFrame(slot: VideoSlot, t: Seconds): Promise<FrameRef | null> {
    if (!(await slot.ready)) return null
    const { video } = slot
    this.pause(slot)
    slot.target = t
    slot.seeking = slot.seeking.then(() => this.seek(slot))
    await slot.seeking
    return { source: video, width: video.videoWidth, height: video.videoHeight }
  }

  private async playingFrame(
    asset: Asset,
    t: Seconds,
    slot: VideoSlot,
    mediaRate: number,
  ): Promise<FrameRef | null> {
    if (!(await slot.ready)) return null
    const { video } = slot
    // Upload only frames the video presented since the last upload (a 30 fps clip in a 60 fps preview skips every
    // other upload). Exact frames always upload: a seek does not reliably present a new frame callback.
    const version = slot.presented > 0 ? slot.presented : undefined
    // Drift is measured in source time, which moves at mediaRate; allow at least two source frames.
    const frame = 1 / (asset.frameRate ?? 30)
    const tolerance = Math.max(PLAYBACK_DRIFT * mediaRate, 2 * frame)
    const drift = t - video.currentTime
    let speed = mediaRate
    if (video.paused) {
      // A warmed or taken-over element is usually already there; seeking anyway would stall its first frames.
      if (Math.abs(drift) > tolerance) video.currentTime = t
      void video.play().catch(() => undefined)
    } else if (Math.abs(drift) > tolerance) {
      video.currentTime = t
    } else if (Math.abs(drift) > frame / 2) {
      // Seeking a playing video stalls it, so smaller drift (playback start-up latency, clock skew) is steered
      // out instead; left alone it would show frames a few frames early or late for the rest of the clip.
      const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift / (DRIFT_CATCH_UP * mediaRate)))
      speed = Math.min(
        MAX_MEDIA_RATE,
        Math.max(MIN_MEDIA_RATE, mediaRate * (1 + Math.round(nudge * 20) / 20)),
      )
    }
    if (video.playbackRate !== speed) video.playbackRate = speed
    return { source: video, width: video.videoWidth, height: video.videoHeight, version }
  }

  /** Pauses the element if it is playing, noting when for seek(). */
  private pause(slot: VideoSlot): void {
    if (slot.video.paused) return
    slot.video.pause()
    slot.pausedAt = performance.now()
  }

  private async seek(slot: VideoSlot): Promise<void> {
    const { video } = slot
    const t = slot.target
    if (Math.abs(video.currentTime - t) < 1e-6 && !video.seeking) return
    const from = video.currentTime
    // Just after a playing element is paused, the media pipeline can go on presenting playback frames after this seek
    // starts: past where the video paused, for tens of ms while it is busy with other videos. They all come before the
    // seek's own frame, which comes before 'seeked', so one animation frame after 'seeked' the latest frame is its own.
    const justPaused = performance.now() - slot.pausedAt < JUST_PAUSED_MS
    // A seek still under way (playback's, warm()'s, or one on an element taken over from another clip) can hand its
    // frame to the compositor after this one starts.
    const inFlight = video.seeking
    const start = performance.now()
    video.currentTime = t
    await once(video, ['seeked', 'error'], 5_000)
    if (justPaused) await nextFrame(FRAME_TIMEOUT_MS)
    // Chrome hands each seek's frame to the compositor before 'seeked' fires, even a seek within the frame already
    // shown, and the frame's presentationTime says when, however late its callback runs. So the seek's own frame went
    // there after the seek started; an earlier one (the previous seek's, or one from playing, in flight at the pause)
    // went before. The frame shown for `t` starts at or just before it: up to a second before in low frame rate
    // footage, whatever frame rate the asset reports. While another seek was under way, going forward it must also be
    // past where the video was, or it may be that seek's frame.
    const near = (mediaTime: Seconds) => mediaTime <= t + 0.01 && mediaTime > t - MAX_FRAME_SPACING
    const own = (mediaTime: Seconds, presentedAt: number) =>
      presentedAt > start && near(mediaTime) && (!inFlight || t < from || mediaTime > from)
    if (!('requestVideoFrameCallback' in video) || own(slot.presentedTime, slot.presentedAt)) return
    // The frame's callback can run after 'seeked': wait for it, passing over earlier frames' (bounded, in case it never
    // comes).
    await new Promise<void>((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        done = true
        resolve()
      }, 120)
      const watch = () =>
        video.requestVideoFrameCallback((_now, metadata) => {
          if (done) return
          if (own(metadata.mediaTime, metadata.presentationTime)) {
            done = true
            clearTimeout(timer)
            resolve()
          } else watch()
        })
      watch()
    })
  }

  /**
   * Prepares elements for clips about to start, so their first frames need no load or seek: each is loaded and
   * seeked to the clip's first frame, and in the last PREROLL seconds it starts playing (invisibly) at the position
   * that reaches that frame exactly at the cut, hiding the element's playback start-up latency. Each call replaces
   * the previous set; requests come from the playing preview.
   */
  warm(
    requests: { asset: Asset; sourceTime: Seconds; key: string; startsIn: Seconds; rate: number }[],
  ): void {
    this.upcoming = new Set()
    for (const { asset, sourceTime, key, startsIn, rate } of requests) {
      const t = clampSourceTime(asset, sourceTime)
      const slot = this.slot(asset, key, t)
      this.upcoming.add(`${key}:${asset.id}`)
      slot.lastUsed = this.frame
      void slot.ready.then((ok) => {
        const { video } = slot
        if (!ok || video.seeking) return
        const mediaRate = rate * this.rate
        const from = t - startsIn * mediaRate
        const playable = mediaRate >= MIN_MEDIA_RATE && mediaRate <= MAX_MEDIA_RATE
        if (this.playing && playable && startsIn <= PREROLL && from >= 0) {
          if (!video.paused) return
          video.playbackRate = mediaRate
          video.currentTime = from
          void video.play().catch(() => undefined)
        } else if (video.paused && Math.abs(video.currentTime - t) > 1e-3) {
          video.currentTime = t
        }
      })
    }
  }
  /**
   * While paused, keeps an element loaded and seeked for each clip that a transition near the playhead shows besides
   * the clips on screen. Without it, a seek into the transition has to load a new element for the clip it brings back,
   * which costs more than the seek itself. Each call replaces the previous set. Elements no longer wanted are released
   * at once, unless the frame on screen uses them.
   */
  prewarm(requests: { asset: Asset; sourceTime: Seconds; key: string }[]): void {
    const wanted = new Set(requests.map(({ asset, key }) => `${key}:${asset.id}`))
    for (const id of this.prewarmed) {
      const slot = this.slots.get(id)
      if (!wanted.has(id) && slot && !this.active.has(slot.clipKey) && !this.upcoming.has(id))
        this.release(id, slot)
    }
    this.prewarmed = wanted
    for (const { asset, sourceTime, key } of requests) {
      const t = clampSourceTime(asset, sourceTime)
      const slot = this.slot(asset, key, t)
      slot.lastUsed = this.frame
      slot.target = t
      slot.seeking = slot.seeking.then(async () => {
        if ((await slot.ready) && slot.video.paused) await this.seek(slot)
      })
    }
  }

  /** Keeps one loaded element per asset (e.g. VJ pad footage) until the next prefetch() call. */
  prefetch(assets: Asset[]): void {
    const ids = new Set(assets.map((a) => a.id))
    for (const slot of this.slots.values()) slot.pinned = ids.has(slot.assetId)
    for (const asset of assets) {
      const has = [...this.slots.values()].some((s) => s.assetId === asset.id)
      if (!has) this.slot(asset, `prefetch:${asset.id}`, 0).pinned = true
    }
  }

  endFrame(): void {
    this.exact.clear()
    this.frame++
    const idleSlots: [string, VideoSlot][] = []
    for (const [key, slot] of this.slots) {
      const idle = this.frame - slot.lastUsed
      if (idle > PAUSE_AFTER_FRAMES && !this.upcoming.has(key)) this.pause(slot)
      if (idle <= PAUSE_AFTER_FRAMES || slot.pinned || this.upcoming.has(key) || this.prewarmed.has(key))
        continue
      if (idle > RELEASE_AFTER_FRAMES) this.release(key, slot)
      else idleSlots.push([key, slot])
    }
    idleSlots.sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    let pixels = 0
    for (const [key, slot] of idleSlots) {
      pixels += slot.video.videoWidth * slot.video.videoHeight
      if (pixels > IDLE_PIXEL_BUDGET) this.release(key, slot)
    }
  }

  private release(id: string, slot: VideoSlot): void {
    slot.video.pause()
    slot.video.removeAttribute('src')
    slot.video.load()
    this.slots.delete(id)
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      slot.video.pause()
      slot.video.removeAttribute('src')
      slot.video.load()
    }
    this.slots.clear()
    this.prewarmed.clear()
    for (const url of this.urls.values()) void url.then((u) => URL.revokeObjectURL(u))
    this.urls.clear()
    this.images.dispose()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Export: WebCodecs decoding through mediabunny

/** A sequential decode cursor over one video track. Seeking backwards or far ahead restarts at a key frame. */
class DecodeCursor {
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null
  private current: VideoSample | null = null
  private next: VideoSample | null = null
  private lastTime = -Infinity
  private readonly sink: VideoSampleSink

  constructor(track: InputVideoTrack) {
    this.sink = new VideoSampleSink(track)
  }

  private static readonly RESTART_GAP = 2

  async at(t: Seconds): Promise<VideoSample | null> {
    const cur = this.current
    if (!this.iterator || t < this.lastTime || (cur && t > cur.timestamp + DecodeCursor.RESTART_GAP)) {
      await this.restart(t)
    }
    this.lastTime = t
    while (this.next && this.next.timestamp <= t) {
      this.current?.close()
      this.current = this.next
      this.next = await this.pull()
    }
    return this.current
  }

  private async pull(): Promise<VideoSample | null> {
    const result = await this.iterator?.next()
    return result && !result.done ? result.value : null
  }

  private async restart(t: Seconds): Promise<void> {
    await this.close()
    // samples(t) starts with the last frame whose timestamp is <= t.
    this.iterator = this.sink.samples(t)
    this.current = await this.pull()
    this.next = await this.pull()
  }

  async close(): Promise<void> {
    this.current?.close()
    this.next?.close()
    this.current = null
    this.next = null
    await this.iterator?.return()
    this.iterator = null
  }
}

/**
 * Chrome's <video> treats video without color tags as BT.601 below 720 lines and BT.709 otherwise, while mediabunny
 * tags every untagged frame BT.709. Returns the color space that makes frames decoded through mediabunny (the export
 * decoder, thumbnail frames) look as the preview's <video> shows them, or null when the frames are already tagged
 * correctly.
 */
export async function previewColorSpace(track: InputVideoTrack): Promise<VideoColorSpaceInit | null> {
  const declared = await track.getColorSpace()
  if (declared.matrix || (await track.getCodedHeight()) >= 720) return null
  return {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'smpte170m',
    fullRange: declared.fullRange ?? false,
  }
}

/**
 * Copies a frame's pixels into a new frame with a different color space tag (VideoFrameInit cannot re-tag). On success
 * the input frame is closed and the new one returned; if the copy fails, the input frame is returned, still open.
 */
export async function retag(frame: VideoFrame, colorSpace: VideoColorSpaceInit): Promise<VideoFrame> {
  const rect = frame.visibleRect
  if (!frame.format || !rect) return frame
  try {
    const buffer = new Uint8Array(frame.allocationSize())
    const layout = await frame.copyTo(buffer)
    const out = new VideoFrame(buffer, {
      format: frame.format,
      codedWidth: rect.width,
      codedHeight: rect.height,
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      timestamp: frame.timestamp,
      duration: frame.duration ?? undefined,
      layout,
      colorSpace,
    })
    frame.close()
    return out
  } catch {
    return frame
  }
}

interface Decoder {
  cursor: DecodeCursor
  colorSpace: VideoColorSpaceInit | null
}

/** A decode cursor over one footage and the request key (clip) it serves, with its rotation canvas. */
interface DecoderSlot {
  key: string
  assetId: Id
  decoder: Promise<Decoder | null>
  canvas?: OffscreenCanvas
}

export class DecoderFrameProvider implements FrameProvider {
  private readonly tracks = new Map<
    Id,
    Promise<{ track: InputVideoTrack; colorSpace: VideoColorSpaceInit | null } | null>
  >()
  /** By request key and asset id. */
  private readonly slots = new Map<string, DecoderSlot>()
  private readonly images: ImageCache
  private readonly media: MediaFileSource
  private readonly openInputs: Input[] = []
  /** Frames handed out for the current render; closed in endFrame(). */
  private pending: VideoFrame[] = []
  /** Request keys of the frame being rendered (beginFrame), or null when the caller does not name them. */
  private frameKeys: Set<string> | null = null

  constructor(media: MediaFileSource) {
    this.media = media
    this.images = new ImageCache(media)
  }

  image(asset: Asset): Promise<FrameRef | null> {
    return this.images.get(asset)
  }

  private track(asset: Asset) {
    let track = this.tracks.get(asset.id)
    if (!track) {
      track = this.media.getFile(asset).then(async (blob) => {
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
        this.openInputs.push(input)
        const video = await input.getPrimaryVideoTrack()
        return video && { track: video, colorSpace: await previewColorSpace(video) }
      })
      this.tracks.set(asset.id, track)
    }
    return track
  }

  beginFrame(keys: string[]): void {
    this.frameKeys = new Set(keys)
  }

  /**
   * The slot for a clip: its own, the slot of a clip of the same footage that left the frame (a contiguous piece
   * decodes on from where that one stopped, and a jump restarts at a key frame), or a new one.
   */
  private slot(asset: Asset, key: string): DecoderSlot {
    const id = `${key}:${asset.id}`
    let slot = this.slots.get(id)
    if (slot) return slot
    if (this.frameKeys)
      for (const [otherId, other] of this.slots) {
        if (other.assetId !== asset.id || this.frameKeys.has(other.key)) continue
        this.slots.delete(otherId)
        other.key = key
        this.slots.set(id, other)
        return other
      }
    slot = {
      key,
      assetId: asset.id,
      decoder: this.track(asset).then(
        (t) => t && { cursor: new DecodeCursor(t.track), colorSpace: t.colorSpace },
      ),
    }
    this.slots.set(id, slot)
    return slot
  }

  async videoFrame(asset: Asset, sourceTime: Seconds, key: string): Promise<FrameRef | null> {
    const slot = this.slot(asset, key)
    const decoder = await slot.decoder
    const sample = await decoder?.cursor.at(clampSourceTime(asset, sourceTime))
    if (!decoder || !sample) return null
    let frame = sample.toVideoFrame()
    if (decoder.colorSpace) frame = await retag(frame, decoder.colorSpace)
    this.pending.push(frame)
    if (sample.rotation === 0 && !sample.flip) {
      return { source: frame, width: frame.displayWidth, height: frame.displayHeight }
    }
    // VideoFrame uploads ignore container rotation; apply it like <video> does in preview.
    const w = sample.displayWidth
    const h = sample.displayHeight
    let canvas = slot.canvas
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h)
      slot.canvas = canvas
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const sideways = sample.rotation === 90 || sample.rotation === 270
    const [fw, fh] = sideways ? [h, w] : [w, h]
    ctx.setTransform(1, 0, 0, 1, w / 2, h / 2)
    if (sample.flip) ctx.scale(-1, 1)
    ctx.rotate((sample.rotation * Math.PI) / 180)
    ctx.drawImage(frame, -fw / 2, -fh / 2, fw, fh)
    return { source: canvas, width: w, height: h }
  }

  endFrame(): void {
    for (const frame of this.pending) frame.close()
    this.pending = []
    const keys = this.frameKeys
    this.frameKeys = null
    if (!keys) return
    // A cursor holds a decoder and a few decoded frames (over 100 MB at 4K). Kept for every clip of a beat-cut export
    // until the end, they ran a 4K project out of memory; a clip that leaves and comes back starts a new one.
    for (const [id, slot] of this.slots)
      if (!keys.has(slot.key)) {
        this.slots.delete(id)
        void slot.decoder.then((d) => d?.cursor.close())
      }
  }

  dispose(): void {
    this.frameKeys = null
    this.endFrame()
    for (const slot of this.slots.values()) void slot.decoder.then((d) => d?.cursor.close())
    this.slots.clear()
    for (const input of this.openInputs) input.dispose()
    this.openInputs.length = 0
    this.tracks.clear()
    this.images.dispose()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Worker preview: frames bridged from the main thread's <video> elements

/** One video frame of a worker preview frame, taken on the main thread from the clip's <video> element. */
export interface BridgedVideo {
  /** VideoRequest key: the clip id, or `matte:<clip id>`. */
  key: string
  /** The frame, or null when it is unavailable or unchanged (`same`). */
  frame: VideoFrame | null
  width: number
  height: number
  /** FrameRef.version of the frame. */
  version?: number
  /** The frame is the one last sent for this key (same version), so it is not sent again. */
  same?: boolean
  /** The frame went ahead of the request (BridgedFrameProvider.stage) with this version. */
  staged?: boolean
}

/** A frame sent ahead is dropped when this many renders went by without one taking it (its request failed). */
const STAGED_RENDERS = 8

/**
 * Frame provider of the preview in the render worker: video frames arrive from the main thread with each render
 * request (set()), images are decoded here. The latest frame per key stays open, so an unchanged frame is never sent
 * twice and can still be uploaded again (after a lost context).
 */
export class BridgedFrameProvider implements FrameProvider {
  private readonly latest = new Map<string, { frame: VideoFrame; ref: FrameRef }>()
  private current = new Map<string, FrameRef | null>()
  /** Frames sent ahead of their render, by key and version, and the render count when each came. */
  private readonly staged = new Map<string, { frame: VideoFrame; ref: FrameRef; at: number }>()
  private renders = 0
  private readonly images: ImageCache

  constructor(media: MediaFileSource) {
    this.images = new ImageCache(media)
  }

  /** Keeps a frame sent ahead of the render that will name it (`staged`) by its key and version. */
  stage(v: BridgedVideo): void {
    if (!v.frame) return
    const id = `${v.key}@${String(v.version)}`
    this.staged.get(id)?.frame.close()
    this.staged.set(id, {
      frame: v.frame,
      ref: { source: v.frame, width: v.width, height: v.height, version: v.version },
      at: this.renders,
    })
  }

  /** The video frames of the next render. Frames of keys missing from `videos` are closed. */
  set(videos: BridgedVideo[]): void {
    this.renders++
    const current = new Map<string, FrameRef | null>()
    for (const v of videos) {
      let entry = this.latest.get(v.key)
      if (v.staged) {
        const id = `${v.key}@${String(v.version)}`
        const staged = this.staged.get(id)
        this.staged.delete(id)
        if (entry && entry.frame !== staged?.frame) entry.frame.close()
        entry = staged && { frame: staged.frame, ref: staged.ref }
        if (entry) this.latest.set(v.key, entry)
        else this.latest.delete(v.key)
      } else if (v.frame) {
        entry?.frame.close()
        entry = {
          frame: v.frame,
          ref: { source: v.frame, width: v.width, height: v.height, version: v.version },
        }
        this.latest.set(v.key, entry)
      } else if (!v.same && entry) {
        entry.frame.close()
        this.latest.delete(v.key)
        entry = undefined
      }
      current.set(v.key, entry?.ref ?? null)
    }
    for (const [key, entry] of this.latest)
      if (!current.has(key)) {
        entry.frame.close()
        this.latest.delete(key)
      }
    for (const [id, staged] of this.staged)
      if (this.renders - staged.at > STAGED_RENDERS) {
        staged.frame.close()
        this.staged.delete(id)
      }
    this.current = current
  }

  videoFrame(_asset: Asset, _sourceTime: Seconds, key: string): Promise<FrameRef | null> {
    return Promise.resolve(this.current.get(key) ?? null)
  }

  image(asset: Asset): Promise<FrameRef | null> {
    return this.images.get(asset)
  }

  dispose(): void {
    for (const entry of [...this.latest.values(), ...this.staged.values()]) entry.frame.close()
    this.latest.clear()
    this.staged.clear()
    this.current.clear()
    this.images.dispose()
  }
}
