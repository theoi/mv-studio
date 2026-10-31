import type { MediaFileSource } from '../../engine/types.ts'
import type { Asset } from '../../model/types.ts'
import { createVideoElementSource, type FrameSource } from './frames.ts'

/**
 * Small frames of videos at a source time, for per-clip thumbnails such as timeline clips. Each video keeps one
 * decoder that seeks for every frame, a few videos decode at once, the newest request goes first, and requests
 * released before their turn are skipped, so dragging a clip's in-point decodes only where the drag stops.
 */
export interface FrameThumbnails {
  /** JPEG data URL of `asset` at `sourceTime`; undefined until it is made, when it cannot be decoded, or for non-video assets. */
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
  /** Opens a decoder for a video file. Default: an HTMLVideoElement that seeks per frame. */
  open?: (asset: Asset, file: Blob) => Promise<OpenedSource>
  /** Turns a decoded frame into an image URL of the given size. Default: a centered cover crop as JPEG. */
  draw?: (frame: ImageBitmap, width: number, height: number) => string
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

function drawCover(frame: ImageBitmap, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas for a thumbnail')
  const scale = Math.max(width / frame.width, height / frame.height)
  const w = frame.width * scale
  const h = frame.height * scale
  ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h)
  return canvas.toDataURL('image/jpeg', 0.8)
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
      createVideoElementSource(file, asset.id, asset.frameRate ? { frameRate: asset.frameRate } : {}))
  const draw = options.draw ?? drawCover

  const holders = new Map<string, Holder>()
  /** Made frames in least-recently-requested order; null when the frame could not be decoded. */
  const made = new Map<string, string | null>()
  const inFlight = new Set<string>()
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
      if (!holders.has(key)) made.delete(key)
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
      source: media.getFile(asset).then((file) => open(asset, file)),
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
      try {
        const source = await decoder.source
        opened = true
        const cover = Math.max(width / source.width, height / source.height)
        const maxSide = Number.isFinite(cover)
          ? Math.ceil(Math.max(source.width, source.height) * cover)
          : undefined
        const bitmap = await source.frameAt(time, maxSide !== undefined ? { maxSide } : {})
        try {
          url = draw(bitmap, width, height)
        } finally {
          bitmap.close()
        }
      } catch {
        // A video that does not open gets no thumbnails; a frame that does not decode stays empty. Neither retries.
        if (!opened) failed.add(asset.id)
      }
      inFlight.delete(key)
      if (disposed) return
      decoder.busy = false
      decoder.lastUsed = ++uses
      if (failed.has(asset.id)) close(asset.id)
      else if (decoders.get(asset.id) === decoder) decoder.timer = setTimeout(() => close(asset.id), idleMs)
      made.set(key, url)
      evict()
      for (const listener of listeners) listener()
      pump()
    })()
  }

  const pump = () => {
    if (disposed) return
    const waiting = [...holders]
      .filter(([key, h]) => !made.has(key) && !inFlight.has(key) && !failed.has(h.asset.id))
      .sort((a, b) => b[1].asked - a[1].asked)
    const started = new Set<string>()
    for (const [key, holder] of waiting) {
      if (started.has(holder.asset.id)) continue
      const decoder = decoderFor(holder.asset)
      if (!decoder) continue
      started.add(holder.asset.id)
      run(key, holder, decoder)
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
      made.clear()
      listeners.clear()
    },
  }
}
