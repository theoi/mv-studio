import { useEffect, useSyncExternalStore } from 'react'
import type { Asset } from '../../model/index.ts'
import { sceneThumb } from '../mock/art.ts'
import { sceneOf } from '../mock/demoProject.ts'
import { appMedia } from './media.ts'

/** Library thumbnails: drawn scenes for sample assets, a 320×180 frame of the file for imported ones. */

const WIDTH = 320
const HEIGHT = 180
const thumbs = new Map<string, string | null>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function once(target: EventTarget, ok: string, fail = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(ok, () => resolve(), { once: true })
    target.addEventListener(fail, () => reject(new Error(`${fail} while making a thumbnail`)), { once: true })
  })
}

interface Frame {
  source: CanvasImageSource
  width: number
  height: number
  close(): void
}

async function frameOf(asset: Asset, file: Blob): Promise<Frame> {
  if (asset.kind === 'image') {
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url
  try {
    await once(video, 'loadeddata')
    video.currentTime = Math.min(1, (video.duration || 0) * 0.1)
    await once(video, 'seeked')
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    return { source: canvas, width: canvas.width, height: canvas.height, close: () => undefined }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function makeThumb(asset: Asset): Promise<string | null> {
  if (asset.kind !== 'image' && asset.kind !== 'video') return null
  const frame = await frameOf(asset, await appMedia.getFile(asset))
  try {
    const { width: sw, height: sh } = frame
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH
    canvas.height = HEIGHT
    const ctx = canvas.getContext('2d')
    if (!ctx || !sw || !sh) return null
    const scale = Math.max(WIDTH / sw, HEIGHT / sh)
    ctx.drawImage(frame.source, (WIDTH - sw * scale) / 2, (HEIGHT - sh * scale) / 2, sw * scale, sh * scale)
    return canvas.toDataURL('image/jpeg', 0.84)
  } finally {
    frame.close()
  }
}

function request(asset: Asset): void {
  if (thumbs.has(asset.id)) return
  thumbs.set(asset.id, null)
  void makeThumb(asset)
    .catch(() => null)
    .then((url) => {
      thumbs.set(asset.id, url)
      for (const l of listeners) l()
    })
}

/** A thumbnail image of an image or video asset, e.g. for a project's card on the start screen. */
export async function thumbnailBlob(asset: Asset): Promise<Blob | null> {
  const scene = sceneOf(asset)
  const url = scene ? sceneThumb(scene) : (thumbs.get(asset.id) ?? (await makeThumb(asset)))
  return url ? (await fetch(url)).blob() : null
}

/** The thumbnail URL for an asset, or undefined while it is being made (or for audio). */
export function useThumbnail(asset: Asset): string | undefined {
  const scene = sceneOf(asset)
  const made = useSyncExternalStore(subscribe, () => thumbs.get(asset.id))
  useEffect(() => {
    if (!scene) request(asset)
  }, [asset, scene])
  if (scene) return sceneThumb(scene)
  return made ?? undefined
}
