import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Asset } from '../../model/index.ts'
import { coverJpeg, coverSide, createFrameThumbnails, openVideoFrames } from '../../vision/index.ts'
import { sceneThumb } from '../mock/art.ts'
import { sceneOf } from '../mock/demoProject.ts'
import { appMedia } from './media.ts'

/** Library thumbnails: drawn scenes for sample assets, a 320×180 frame of the file for imported ones. */

const WIDTH = 320
const HEIGHT = 180
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

async function makeThumb(asset: Asset): Promise<Blob | null> {
  if (asset.kind !== 'image' && asset.kind !== 'video') return null
  const frame = await frameOf(asset, await appMedia.getFile(asset))
  try {
    return await coverJpeg(frame, WIDTH, HEIGHT, 0.84)
  } finally {
    frame.close()
  }
}

function pump(): void {
  while (running < AT_ONCE && queue.length) {
    const asset = queue.shift()!
    running++
    void makeThumb(asset)
      .catch(() => null)
      .then((blob) => {
        running--
        thumbs.set(asset.id, blob ? URL.createObjectURL(blob) : null)
        for (const l of listeners) l()
        pump()
      })
  }
}

function request(asset: Asset): void {
  if (thumbs.has(asset.id)) return
  thumbs.set(asset.id, null)
  queue.push(asset)
  pump()
}

/** A thumbnail image of an image or video asset, e.g. for a project's card on the start screen. */
export async function thumbnailBlob(asset: Asset): Promise<Blob | null> {
  const scene = sceneOf(asset)
  if (scene) return (await fetch(sceneThumb(scene))).blob()
  const made = thumbs.get(asset.id)
  return made ? (await fetch(made)).blob() : makeThumb(asset)
}

/** The thumbnail URL for an asset, or undefined while it is being made (or for audio). */
export function useThumbnail(asset: Asset | undefined): string | undefined {
  const scene = sceneOf(asset)
  const made = useSyncExternalStore(subscribe, () => (asset ? thumbs.get(asset.id) : undefined))
  useEffect(() => {
    if (asset && !scene) request(asset)
  }, [asset, scene])
  if (scene) return sceneThumb(scene)
  return made ?? undefined
}

const frames = createFrameThumbnails(appMedia)

/**
 * A 160×90 frame of a clip's video at `sourceTime` (usually the clip's in-point, `clip.sourceStart`), e.g. for a
 * timeline clip. While the frame for a new time is being made (the in-point is trimmed), the last frame shown stays.
 * Images, sample media and videos with no frame made yet get the asset's thumbnail.
 */
export function useFrameThumbnail(asset: Asset | undefined, sourceTime: number): string | undefined {
  const scene = sceneOf(asset)
  const whole = useThumbnail(asset)
  const frame = useSyncExternalStore(frames.subscribe, () =>
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
