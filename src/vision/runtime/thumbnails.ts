import type { MediaFileSource } from '../../engine/types.ts'
import type { Asset } from '../../model/types.ts'
import type { Size } from '../types.ts'
import type { FrameSource } from './frames.ts'
import { openVideoFrames } from './videoFrames.ts'

/**
 * Small frames of videos at a source time, for per-clip thumbnails such as timeline clips. Each video keeps one
 * decoder (in a worker, see `openVideoFrames`) that seeks for every frame, a few videos decode at once, the newest request goes first, and requests
 * released before their turn are skipped, so dragging a clip's in-point decodes only where the drag stops. Frames kept
 * in an optional cache show without decoding.
 */
export interface FrameThumbnails {
  /** JPEG object URL of `asset` at `sourceTime`; undefined until it is made, when it cannot be decoded, or for non-video assets. */
  get(asset: Asset, sourceTime: number): string | undefined
  /** Asks for the frame. Call the returned function once it is no longer shown. */
  want(asset: Asset, sourceTime: number): () => void
  /** Called after each frame is made. */
  subscribe(listener: () => void): () => void
  dispose(): void
}

type OpenedSource = FrameSource & { dispose(): void }

export interface FrameThumbnailOptions {
  /** Thumbnail size in pixels; frames are scaled to cover it and centered. Default 160×90. */
  width?: number
  height?: number
  /** Source times round to multiples of this many seconds, so nearby in-points share one frame. Default 0.5. */
  step?: number
  /** Videos decoding at once. Default 2. */
  maxOpen?: number
  /** A video's decoder closes after this long without work. Default 5 s. */
  idleMs?: number
  /** Frames kept; the least recently requested ones that are not shown go first. Default 500. */
  maxEntries?: number
  /** Opens a decoder for a video file. Default: `openVideoFrames`. */
  open?: (asset: Asset, file: Blob) => Promise<OpenedSource>
  /** Turns a decoded frame into an image of the given size: a JPEG, shown as an object URL, or a URL. Default: `coverJpeg()`. */
  draw?: (frame: ImageBitmap, width: number, height: number) => Blob | string | Promise<Blob | string>
  /** Keeps frames between page loads: a frame found there shows without opening its video, and each JPEG made goes there. */
  cache?: FrameCache
  /**
   * Videos open, and frames decode, only once this resolves (e.g. after the preview's first frame); it is called again
   * before each frame, so a newer hold also pauses a video that is already open. A frame released while waiting is not
   * decoded. Frames found in `cache` don't wait.
   */
  ready?: () => Promise<void>
}

/** Frames kept between page loads. `name` tells an asset's frames apart by size and source time. */
export interface FrameCache {
  get(asset: Asset, name: string): Promise<Blob | null>
  put(asset: Asset, name: string, jpeg: Blob): void
}

interface Holder {
  asset: Asset
  time: number
  count: number
  asked: number
}

interface Decoder {
  source: Promise<OpenedSource>
  busy: boolean
  lastUsed: number
  timer?: ReturnType<typeof setTimeout>
}

/** The longest side to decode a `source`-sized image at so it still covers `width`×`height`; undefined when its size is unknown. */
export function coverSide(source: Size, width: number, height: number): number | undefined {
  const cover = Math.max(width / source.width, height / source.height)
  return Number.isFinite(cover) && cover > 0
    ? Math.ceil(Math.max(source.width, source.height) * cover)
    : undefined
}

/**
 * A centered cover crop of `frame` as a `width`×`height` JPEG. Decode the frame at about that size first (see
 * `coverSide`): drawing a full-size video frame on the page costs tens of milliseconds, while this small draw is
 * cheap and the encoding does not block the page.
 */
export function coverJpeg(frame: ImageBitmap, width: number, height: number, quality = 0.8): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas for a thumbnail')
  const scale = Math.max(width / frame.width, height / frame.height)
  const w = frame.width * scale
  const h = frame.height * scale
  ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

const revoke = (url: string | null | undefined) => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

export function createFrameThumbnails(
  media: MediaFileSource,
  options: FrameThumbnailOptions = {},
): FrameThumbnails {
  const width = options.width ?? 160
  const height = options.height ?? 90
  const step = options.step ?? 0.5
  const maxOpen = Math.max(1, options.maxOpen ?? 2)
  const idleMs = options.idleMs ?? 5000
  const maxEntries = options.maxEntries ?? 500
  const open =
    options.open ??
    ((asset: Asset, file: Blob) =>
      openVideoFrames(file, asset.id, asset.frameRate ? { frameRate: asset.frameRate } : {}))
  const draw = options.draw ?? coverJpeg
  const cache = options.cache
  const ready = options.ready ?? (() => Promise.resolve())

  const holders = new Map<string, Holder>()
  /** Made frames in least-recently-requested order; null when the frame could not be decoded. */
  const made = new Map<string, string | null>()
  const inFlight = new Set<string>()
  /** Frames being looked up in the cache, and frames it doesn't have, which are decoded. */
  const looking = new Set<string>()
  const uncached = new Set<string>()
  const failed = new Set<string>()
  const decoders = new Map<string, Decoder>()
  const listeners = new Set<() => void>()
  let asked = 0
  let uses = 0
  let disposed = false

  const slot = (asset: Asset, t: number) => {
    const end = asset.duration && asset.duration > 0 ? asset.duration : Infinity
    const index = Math.round(Math.min(Math.max(0, t), end) / step)
    return { key: `${asset.id}@${index}`, time: index * step }
  }
  const nameOf = (time: number) => `frame-${width}x${height}-${Math.round(time * 1000)}`

  const touch = (key: string) => {
    const value = made.get(key)
    if (value === undefined) return
    made.delete(key)
    made.set(key, value)
  }

  const evict = () => {
    if (made.size <= maxEntries) return
    for (const key of made.keys()) {
      if (made.size <= maxEntries) return
      if (holders.has(key)) continue
      revoke(made.get(key))
      made.delete(key)
      // Kept in the cache by now, so it is looked up there when it is wanted again.
      uncached.delete(key)
    }
  }

  const close = (assetId: string) => {
    const decoder = decoders.get(assetId)
    if (!decoder) return
    clearTimeout(decoder.timer)
    decoders.delete(assetId)
    decoder.source.then(
      (s) => s.dispose(),
      () => undefined,
    )
  }

  const decoderFor = (asset: Asset): Decoder | undefined => {
    const existing = decoders.get(asset.id)
    if (existing) return existing.busy ? undefined : existing
    if (decoders.size >= maxOpen) {
      let oldest: [string, Decoder] | undefined
      for (const entry of decoders)
        if (!entry[1].busy && (!oldest || entry[1].lastUsed < oldest[1].lastUsed)) oldest = entry
      if (!oldest) return undefined
      close(oldest[0])
    }
    const decoder: Decoder = {
      source: ready()
        .then(() => media.getFile(asset))
        .then((file) => open(asset, file)),
      busy: false,
      lastUsed: 0,
    }
    decoders.set(asset.id, decoder)
    return decoder
  }

  const run = (key: string, holder: Holder, decoder: Decoder) => {
    const { asset, time } = holder
    decoder.busy = true
    clearTimeout(decoder.timer)
    inFlight.add(key)
    void (async () => {
      let url: string | null = null
      let opened = false
      let skipped = false
      try {
        const source = await decoder.source
        opened = true
        await ready()
        skipped = !holders.has(key)
        if (!skipped) {
          const maxSide = coverSide(source, width, height)
          const bitmap = await source.frameAt(time, maxSide !== undefined ? { maxSide } : {})
          try {
            const image = await draw(bitmap, width, height)
            if (typeof image === 'string') url = image
            else {
              url = URL.createObjectURL(image)
              cache?.put(asset, nameOf(time), image)
            }
          } finally {
            bitmap.close()
          }
        }
      } catch {
        // A video that does not open gets no thumbnails; a frame that does not decode stays empty. Neither retries.
        if (!opened) failed.add(asset.id)
      }
      inFlight.delete(key)
      if (disposed) return revoke(url)
      decoder.busy = false
      decoder.lastUsed = ++uses
      if (failed.has(asset.id)) close(asset.id)
      else if (decoders.get(asset.id) === decoder) decoder.timer = setTimeout(() => close(asset.id), idleMs)
      if (!skipped) {
        made.set(key, url)
        evict()
        for (const listener of listeners) listener()
      }
      pump()
    })()
  }

  const lookUp = (key: string, holder: Holder, from: FrameCache) => {
    looking.add(key)
    void from
      .get(holder.asset, nameOf(holder.time))
      .catch(() => null)
      .then((jpeg) => {
        looking.delete(key)
        if (disposed) return
        if (!jpeg) uncached.add(key)
        else if (!made.has(key)) {
          made.set(key, URL.createObjectURL(jpeg))
          evict()
          for (const listener of listeners) listener()
        }
        pump()
      })
  }

  const pump = () => {
    if (disposed) return
    const wanted = [...holders].filter(
      ([key, h]) => !made.has(key) && !inFlight.has(key) && !failed.has(h.asset.id),
    )
    if (cache)
      for (const [key, h] of wanted) if (!looking.has(key) && !uncached.has(key)) lookUp(key, h, cache)
    const waiting = wanted
      .filter(([key]) => !cache || uncached.has(key))
      .sort((a, b) => b[1].asked - a[1].asked)
    const started = new Set<string>()
    // Open videos go first, so clips of a few videos interleaved on the timeline do not reopen one for every frame.
    for (const alreadyOpen of [true, false]) {
      for (const [key, holder] of waiting) {
        const id = holder.asset.id
        if (started.has(id) || decoders.has(id) !== alreadyOpen) continue
        const decoder = decoderFor(holder.asset)
        if (!decoder) continue
        started.add(id)
        run(key, holder, decoder)
      }
    }
  }

  return {
    get(asset, sourceTime) {
      if (asset.kind !== 'video') return undefined
      return made.get(slot(asset, sourceTime).key) ?? undefined
    },
    want(asset, sourceTime) {
      if (asset.kind !== 'video' || disposed) return () => undefined
      const { key, time } = slot(asset, sourceTime)
      const holder = holders.get(key) ?? { asset, time, count: 0, asked: 0 }
      holder.count++
      holder.asked = ++asked
      holders.set(key, holder)
      touch(key)
      pump()
      let released = false
      return () => {
        if (released) return
        released = true
        if (--holder.count === 0 && holders.get(key) === holder) holders.delete(key)
        evict()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      for (const id of [...decoders.keys()]) close(id)
      holders.clear()
      for (const url of made.values()) revoke(url)
      made.clear()
      listeners.clear()
    },
  }
}
