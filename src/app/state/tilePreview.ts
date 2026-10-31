/**
 * Live previews of library tiles: while a tile is hovered, or focused from the keyboard, one shared engine preview
 * plays the item's preview project (src/plugins/preview.ts) on a canvas over the tile's art, silently and on a loop.
 * It draws in the render worker, so compiling an item's shaders the first time does not stall the page. Any kind of
 * library item can be previewed this way. Previews never touch the user's project.
 */
import { useSyncExternalStore, type FocusEvent } from 'react'
import { PreviewController } from '../../engine/preview.ts'
import type { MediaFileSource } from '../../engine/types.ts'
import type { Asset } from '../../model/index.ts'
import {
  lookPreview,
  pluginPreview,
  sampleSceneBlob,
  textStylePreview,
  type PluginPreview,
} from '../../plugins/preview.ts'
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../../plugins/thumbnails.ts'
import { appMedia } from './media.ts'

export interface PreviewItem {
  kind: 'plugin' | 'look' | 'text-style'
  id: string
}

/** Hover this long before a preview starts, so sweeping the pointer across the tiles starts nothing. */
const HOVER_DELAY_MS = 180
const FPS = 30
/** The engine preview (a worker and a WebGL context) is freed after this long without a preview. */
const IDLE_MS = 30_000

/** The sample scene the thumbnails show, generated in memory: previews write nothing to storage. */
const SCENE: Asset = {
  id: 'tile-preview-scene',
  kind: 'image',
  name: 'Sample scene',
  mimeType: 'image/png',
  byteSize: 0,
  storageKey: 'tile-preview:scene',
  width: 1280,
  height: 720,
  origin: { type: 'generated' },
  createdAt: new Date(0).toISOString(),
}
let sceneBlob: Promise<Blob> | null = null
const media: MediaFileSource = {
  getFile: (asset) =>
    asset.id === SCENE.id ? (sceneBlob ??= sampleSceneBlob(1280, 720)) : appMedia.getFile(asset),
}

let shared: { preview: PreviewController; canvas: HTMLCanvasElement } | null = null
let idleTimer = 0
let hoverTimer = 0
let activeKey: string | null = null
const listeners = new Set<() => void>()

export const previewKey = (item: PreviewItem) => `${item.kind}:${item.id}`

function setActive(key: string | null): void {
  if (activeKey === key) return
  activeKey = key
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether `item`'s preview is the one playing. */
export function useTilePreviewActive(item: PreviewItem): boolean {
  const key = previewKey(item)
  return useSyncExternalStore(subscribe, () => activeKey === key)
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Plays `item` after a short hover, in place of any other preview. Nothing plays when motion is reduced. */
export function showTilePreview(item: PreviewItem): void {
  window.clearTimeout(hoverTimer)
  if (reducedMotion()) return
  const key = previewKey(item)
  hoverTimer = window.setTimeout(() => setActive(key), HOVER_DELAY_MS)
}

export function hideTilePreview(item: PreviewItem): void {
  window.clearTimeout(hoverTimer)
  if (activeKey === previewKey(item)) setActive(null)
}

/** Hover and keyboard-focus handlers for a tile, which start and stop its preview. */
export function previewHandlers(item: PreviewItem) {
  return {
    onPointerEnter: () => showTilePreview(item),
    onPointerLeave: () => hideTilePreview(item),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) showTilePreview(item)
    },
    onBlur: () => hideTilePreview(item),
  }
}

function previewOf(item: PreviewItem): PluginPreview | null {
  const options = { image: SCENE }
  try {
    if (item.kind === 'look') return lookPreview(item.id, options)
    if (item.kind === 'text-style') return textStylePreview(item.id, options)
    return pluginPreview(item.id, options)
  } catch (error) {
    console.warn(`No preview for ${previewKey(item)}`, error)
    return null
  }
}

function sharedPreview() {
  if (!shared) {
    const canvas = document.createElement('canvas')
    const preview = new PreviewController({ canvas, media })
    preview.setViewport(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, 1)
    shared = { preview, canvas }
  }
  return shared
}

/**
 * Shows `item`'s preview looping in `host` until the returned stop function is called. The canvas stays hidden
 * (data-ready="false") until the item's first frame is drawn, so the previous item's last frame never shows.
 */
export function playTilePreview(item: PreviewItem, host: HTMLElement): () => void {
  const project = previewOf(item)
  if (!project) return () => undefined
  window.clearTimeout(idleTimer)
  const { preview, canvas } = sharedPreview()
  const [from, to] = project.loop
  canvas.dataset.ready = 'false'
  host.appendChild(canvas)
  preview.seek(from)
  preview.setProject(project.project)
  let frame = 0
  let stopped = false
  // Seeking on every animation frame never lets the preview settle, so wait for the first frame before looping.
  void preview.rendered().then(() => {
    if (stopped) return
    canvas.dataset.ready = 'true'
    const started = performance.now()
    let last = -Infinity
    const tick = (now: number) => {
      if (stopped) return
      frame = requestAnimationFrame(tick)
      if (now - last < 1000 / FPS) return
      last = now
      preview.seek(from + (((now - started) / 1000) % (to - from)))
    }
    frame = requestAnimationFrame(tick)
  })
  return () => {
    stopped = true
    cancelAnimationFrame(frame)
    if (canvas.parentElement === host) canvas.remove()
    idleTimer = window.setTimeout(() => {
      shared?.preview.dispose()
      shared = null
    }, IDLE_MS)
  }
}
