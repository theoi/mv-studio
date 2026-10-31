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
          console.warn(`Image "${asset.name}" could not be decoded`, error)
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
  /** Latest requested time while paused; queued seeks skip to it. */
  target: Seconds
  seeking: Promise<void>
  lastUsed: number
}

/** Re-seek a playing video only when it drifts this far from the clock. */
const PLAYBACK_DRIFT = 0.12
const PAUSE_AFTER_FRAMES = 2
const RELEASE_AFTER_FRAMES = 900

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

export class VideoElementFrameProvider implements FrameProvider {
  private readonly slots = new Map<string, VideoSlot>()
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
    if (!playing) for (const slot of this.slots.values()) slot.video.pause()
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

  private slot(asset: Asset, key: string): VideoSlot {
    let slot = this.slots.get(key)
    if (slot) return slot
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
    slot = { video, ready, target: 0, seeking: Promise.resolve(), lastUsed: this.frame }
    this.slots.set(key, slot)
    return slot
  }

  async videoFrame(asset: Asset, sourceTime: Seconds, key: string): Promise<FrameRef | null> {
    const slot = this.slot(asset, `${key}:${asset.id}`)
    slot.lastUsed = this.frame
    if (!(await slot.ready)) return null
    const { video } = slot
    const t = clampSourceTime(asset, sourceTime)
    if (this.playing) {
      video.playbackRate = this.rate
      if (video.paused) {
        video.currentTime = t
        void video.play().catch(() => undefined)
      } else if (Math.abs(video.currentTime - t) > PLAYBACK_DRIFT) {
        video.currentTime = t
      }
    } else {
      if (!video.paused) video.pause()
      slot.target = t
      slot.seeking = slot.seeking.then(() => this.seek(slot))
      await slot.seeking
    }
    return { source: video, width: video.videoWidth, height: video.videoHeight }
  }

  private async seek(slot: VideoSlot): Promise<void> {
    const { video } = slot
    const t = slot.target
    if (Math.abs(video.currentTime - t) < 1e-6 && !video.seeking) return
    video.currentTime = t
    await once(video, ['seeked', 'error'], 5_000)
    if ('requestVideoFrameCallback' in video) {
      // 'seeked' can fire before the new frame is presented to WebGL; wait for it (bounded, paused videos may not
      // present again when the frame did not change).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120)
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  endFrame(): void {
    this.frame++
    for (const [key, slot] of this.slots) {
      const idle = this.frame - slot.lastUsed
      if (idle > PAUSE_AFTER_FRAMES && !slot.video.paused) slot.video.pause()
      if (idle > RELEASE_AFTER_FRAMES) {
        slot.video.removeAttribute('src')
        slot.video.load()
        this.slots.delete(key)
      }
    }
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      slot.video.pause()
      slot.video.removeAttribute('src')
      slot.video.load()
    }
    this.slots.clear()
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
 * tags every untagged frame BT.709. Returns the color space that makes export decode like preview, or null when the
 * frames are already tagged correctly.
 */
async function previewColorSpace(track: InputVideoTrack): Promise<VideoColorSpaceInit | null> {
  const declared = await track.getColorSpace()
  if (declared.matrix || (await track.getCodedHeight()) >= 720) return null
  return {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'smpte170m',
    fullRange: declared.fullRange ?? false,
  }
}

/** Copies a frame's pixels into a new frame with a different color space tag (VideoFrameInit cannot re-tag). */
async function retag(frame: VideoFrame, colorSpace: VideoColorSpaceInit): Promise<VideoFrame> {
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

export class DecoderFrameProvider implements FrameProvider {
  private readonly tracks = new Map<
    Id,
    Promise<{ track: InputVideoTrack; colorSpace: VideoColorSpaceInit | null } | null>
  >()
  private readonly decoders = new Map<string, Promise<Decoder | null>>()
  private readonly images: ImageCache
  private readonly media: MediaFileSource
  private readonly openInputs: Input[] = []
  /** Frames handed out for the current render; closed in endFrame(). */
  private pending: VideoFrame[] = []
  private canvases = new Map<string, OffscreenCanvas>()

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

  async videoFrame(asset: Asset, sourceTime: Seconds, key: string): Promise<FrameRef | null> {
    const cacheKey = `${key}:${asset.id}`
    let pending = this.decoders.get(cacheKey)
    if (!pending) {
      pending = this.track(asset).then(
        (t) => t && { cursor: new DecodeCursor(t.track), colorSpace: t.colorSpace },
      )
      this.decoders.set(cacheKey, pending)
    }
    const decoder = await pending
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
    let canvas = this.canvases.get(cacheKey)
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h)
      this.canvases.set(cacheKey, canvas)
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
  }

  dispose(): void {
    this.endFrame()
    for (const decoder of this.decoders.values()) void decoder.then((d) => d?.cursor.close())
    this.decoders.clear()
    for (const input of this.openInputs) input.dispose()
    this.openInputs.length = 0
    this.tracks.clear()
    this.canvases.clear()
    this.images.dispose()
  }
}
