import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Asset } from '../../model/index.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { coverJpeg, coverSide, createFrameThumbnails, openVideoFrames } from '../../vision/index.ts'
import { sceneThumb } from '../mock/art.ts'
import { sceneOf } from '../mock/demoProject.ts'
import { appMedia } from './media.ts'

/** Library thumbnails: drawn scenes for sample assets, a 320×180 frame of the file for imported ones. */

const WIDTH = 320
const HEIGHT = 180
const CARD = `card-${WIDTH}x${HEIGHT}`

/**
 * Thumbnails kept beside their media in browser storage, so a reload shows them without decoding the video again; they
 * go when the media is removed. The number in the name changes when thumbnails are drawn differently.
 */
const kept = {
  get: (asset: Asset, name: string): Promise<Blob | null> =>
    mediaStore.readSidecar(asset, `thumb1-${name}.jpg`),
  put: (asset: Asset, name: string, jpeg: Blob): void => {
    void mediaStore.writeSidecar(asset, `thumb1-${name}.jpg`, jpeg).catch(() => undefined)
  },
}

let previewShown: Promise<void> = Promise.resolve()
/** Holds besides the preview's (holdThumbnailsUntil), each until it ends. */
const holds = new Set<Promise<void>>()

/**
 * Holds thumbnail decoding until `shown` resolves (the editor's preview showing a project's first frame): decoding
 * video for thumbnails meanwhile delays that frame. Kept thumbnails don't wait.
 */
export function decodeThumbnailsAfter(shown: Promise<void>): void {
  previewShown = shown
}

/**
 * Holds thumbnail decoding until `done` settles as well, or for `maxMs` at most: e.g. while an export trial times this
 * device, which video decoded for thumbnails meanwhile slows down. Unlike decodeThumbnailsAfter, it adds to the
 * preview's hold instead of replacing it. Kept thumbnails don't wait.
 */
export function holdThumbnailsUntil(done: Promise<unknown>, maxMs: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise((resolve) => (timer = setTimeout(resolve, maxMs)))
  const hold = Promise.race([done, limit]).then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  )
  holds.add(hold)
  void hold.then(() => holds.delete(hold))
}

async function previewFirst(): Promise<void> {
  // A newer hold (another project shown meanwhile) replaces the one waited for; other holds added meanwhile count too.
  for (let hold = previewShown; ; hold = previewShown) {
    await Promise.all([hold, ...holds])
    if (hold === previewShown && holds.size === 0) return
  }
}

/** Thumbnails made at once, so importing many clips does not open a video decoder for each of them together. */
const AT_ONCE = 2
/** Object URLs of made thumbnails by asset id; null while one is waiting or being made, or when it cannot be. */
const thumbs = new Map<string, string | null>()
const queue: Asset[] = []
let running = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** For hooks without media to follow (e.g. timeline text clips), so thumbnail updates do not reach them. */
const noUpdates = () => () => undefined

/** A frame of the asset decoded at about thumbnail size, so drawing it on the page stays cheap. */
async function frameOf(asset: Asset, file: Blob): Promise<ImageBitmap> {
  if (asset.kind === 'image') {
    const { width = 0, height = 0 } = asset
    const side = coverSide({ width, height }, WIDTH, HEIGHT)
    if (!side || side >= Math.max(width, height)) return createImageBitmap(file)
    const scale = side / Math.max(width, height)
    return createImageBitmap(file, {
      resizeWidth: Math.ceil(width * scale),
      resizeHeight: Math.ceil(height * scale),
      resizeQuality: 'medium',
    })
  }
  const video = await openVideoFrames(file, asset.id)
  try {
    const side = coverSide(video, WIDTH, HEIGHT)
    return await video.frameAt(Math.min(1, (video.duration || 0) * 0.1), side ? { maxSide: side } : {})
  } finally {
    video.dispose()
  }
}

const hasCard = (asset: Asset) => asset.kind === 'image' || asset.kind === 'video'

/** Makes the asset's card from its media, and keeps it. */
async function makeThumb(asset: Asset): Promise<Blob | null> {
  if (!hasCard(asset)) return null
  const frame = await frameOf(asset, await appMedia.getFile(asset))
  try {
    const jpeg = await coverJpeg(frame, WIDTH, HEIGHT, 0.84)
    kept.put(asset, CARD, jpeg)
    return jpeg
  } finally {
    frame.close()
  }
}

function show(asset: Asset, card: Blob | null): void {
  thumbs.set(asset.id, card ? URL.createObjectURL(card) : null)
  for (const l of listeners) l()
}

function pump(): void {
  while (running < AT_ONCE && queue.length) {
    const asset = queue.shift()!
    running++
    void previewFirst()
      .then(() => makeThumb(asset))
      .catch(() => null)
      .then((card) => {
        running--
        show(asset, card)
        pump()
      })
  }
}

function request(asset: Asset): void {
  if (thumbs.has(asset.id)) return
  thumbs.set(asset.id, null)
  if (!hasCard(asset)) return
  // Looked up before the queue, so kept cards don't wait behind cards being made.
  void kept
    .get(asset, CARD)
    .catch(() => null)
    .then((card) => {
      if (card) return show(asset, card)
      queue.push(asset)
      pump()
    })
}

/**
 * A thumbnail image of an image or video asset, e.g. for a project's card on the start screen. It doesn't wait for the
 * preview's first frame: saving the project waits for it.
 */
export async function thumbnailBlob(asset: Asset): Promise<Blob | null> {
  const scene = sceneOf(asset)
  if (scene) return (await fetch(sceneThumb(scene))).blob()
  const made = thumbs.get(asset.id)
  if (made) return (await fetch(made)).blob()
  return (await kept.get(asset, CARD).catch(() => null)) ?? makeThumb(asset)
}

/** The thumbnail URL for an asset, or undefined while it is being made (or for audio). */
export function useThumbnail(asset: Asset | undefined): string | undefined {
  const scene = sceneOf(asset)
  const made = useSyncExternalStore(asset && !scene ? subscribe : noUpdates, () =>
    asset ? thumbs.get(asset.id) : undefined,
  )
  useEffect(() => {
    if (asset && !scene) request(asset)
  }, [asset, scene])
  if (scene) return sceneThumb(scene)
  return made ?? undefined
}

const frames = createFrameThumbnails(appMedia, { cache: kept, ready: previewFirst })

/**
 * A 160×90 frame of a clip's video at `sourceTime` (usually the clip's in-point, `clip.sourceStart`), e.g. for a
 * timeline clip. While the frame for a new time is being made (the in-point is trimmed), the last frame shown stays.
 * Images, sample media and videos with no frame made yet get the asset's thumbnail.
 */
export function useFrameThumbnail(asset: Asset | undefined, sourceTime: number): string | undefined {
  const scene = sceneOf(asset)
  const whole = useThumbnail(asset)
  const frame = useSyncExternalStore(asset && !scene ? frames.subscribe : noUpdates, () =>
    asset && !scene ? frames.get(asset, sourceTime) : undefined,
  )
  useEffect(() => (asset && !scene ? frames.want(asset, sourceTime) : undefined), [asset, scene, sourceTime])
  const [last, setLast] = useState<{ assetId: string; time: number; url: string } | null>(null)
  if (frame && asset && last?.url !== frame) setLast({ assetId: asset.id, time: sourceTime, url: frame })
  const kept = !frame && asset && last?.assetId === asset.id ? last : null
  // The kept frame is wanted until a new one replaces it, so the cache does not drop it (and revoke its URL) meanwhile.
  useEffect(() => (asset && kept ? frames.want(asset, kept.time) : undefined), [asset, kept])
  if (scene) return sceneThumb(scene, 160, 90)
  return frame ?? kept?.url ?? whole
}
