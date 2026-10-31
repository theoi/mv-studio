import { useEffect, useSyncExternalStore } from 'react'
import { exportFileName } from '../../engine/export.ts'
import { PreviewController } from '../../engine/preview.ts'
import type { Project, Seconds } from '../../model/index.ts'
import { downloadFile } from './exports.ts'
import { appMedia } from './media.ts'
import { editor } from './project.ts'
import { get, set, toast, useUi } from './ui.ts'

/*
 * Still frames of projects that are not on the main preview, such as export outputs laid out for another format, and
 * full-size frames saved as PNG (Preview › Save frame). One offscreen engine preview renders them one at a time;
 * dialog stills are kept as object URLs by key.
 */

const MAX_STILLS = 32
const urls = new Map<string, string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()
let controller: PreviewController | null = null
let queue: Promise<void> = Promise.resolve()

const versions = new WeakMap<object, number>()
let nextVersion = 1

/** A number for each project object (projects are immutable, so a new object means a change). */
export function versionOf(project: Project): number {
  let v = versions.get(project)
  if (!v) {
    v = nextVersion++
    versions.set(project, v)
  }
  return v
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function store(key: string, url: string): void {
  urls.set(key, url)
  if (urls.size > MAX_STILLS) {
    const [oldest] = urls
    if (oldest) {
      urls.delete(oldest[0])
      URL.revokeObjectURL(oldest[1])
    }
  }
  for (const listener of listeners) listener()
}

function stillsPreview(): PreviewController {
  // A preview whose render worker died can't draw again (the canvas went with the worker): start a new one.
  if (controller?.getSnapshot().error) {
    controller.dispose()
    controller = null
  }
  controller ??= new PreviewController({
    canvas: document.createElement('canvas'),
    media: appMedia,
    preserveDrawingBuffer: true,
  })
  return controller
}

type StillType = 'image/jpeg' | 'image/png'

async function renderOnce(
  project: Project,
  time: Seconds,
  width: number,
  height: number,
  type: StillType,
): Promise<Blob> {
  const preview = stillsPreview()
  preview.setViewport(width, height, 1)
  preview.seek(time)
  preview.setProject(project)
  await preview.rendered()
  // Read through the preview: its canvas may have moved to the render worker.
  const frame = await preview.captureFrame()
  const canvas = new OffscreenCanvas(frame.width, frame.height)
  canvas.getContext('2d')?.drawImage(frame, 0, 0)
  frame.close()
  return canvas.convertToBlob(type === 'image/png' ? { type } : { type, quality: 0.86 })
}

/** One still (JPEG unless asked). When the render worker died during the render, tries once more on a new preview. */
export async function renderStill(
  project: Project,
  time: Seconds,
  width: number,
  height: number,
  type: StillType = 'image/jpeg',
): Promise<Blob> {
  try {
    return await renderOnce(project, time, width, height, type)
  } catch (error) {
    if (!controller?.getSnapshot().error) throw error
    return renderOnce(project, time, width, height, type)
  }
}

/** Runs after the stills already queued, so renders never share the offscreen preview. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function requestStill(key: string, project: Project, time: Seconds, width: number, height: number): void {
  if (urls.has(key) || pending.has(key)) return
  pending.add(key)
  void enqueue(() => renderStill(project, time, width, height))
    .then(
      (blob) => store(key, URL.createObjectURL(blob)),
      (error: unknown) => console.error('Still render failed', error),
    )
    .finally(() => pending.delete(key))
}

/**
 * The project's frame at `time` as an image URL, rendered at `height` pixels and the given aspect ratio. Undefined
 * until it is ready; pass a null key to skip rendering.
 */
export function useStill(
  key: string | null,
  project: Project,
  time: Seconds,
  ratio: number,
  height = 360,
): string | undefined {
  const url = useSyncExternalStore(subscribe, () => (key ? urls.get(key) : undefined))
  useEffect(() => {
    if (key) requestStill(key, project, time, Math.max(2, Math.round(height * ratio)), height)
  }, [key, project, time, ratio, height])
  return url
}

/** Frees the offscreen preview (its WebGL context and audio clock) once queued stills are done. */
export function releaseStills(): void {
  queue = queue.then(() => {
    controller?.dispose()
    controller = null
  })
}

/** "Neon Skyline - 1m07.2s.png": the project name and the moment of the frame. */
export function frameFileName(projectName: string, time: Seconds): string {
  const base = exportFileName(projectName).replace(/\.mp4$/, '')
  const minutes = Math.floor(time / 60)
  const seconds = (time - minutes * 60).toFixed(1).padStart(4, '0')
  return `${base} - ${minutes}m${seconds}s.png`
}

/** Shows a toast until the returned function removes it. */
function progressToast(message: string): () => void {
  toast(message)
  const id = get().toasts.at(-1)?.id
  return () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

let saving: Promise<void> | null = null

async function downloadFrame(time: Seconds): Promise<void> {
  const project = editor.getProject()
  const { width, height } = project.settings
  const name = frameFileName(project.name, time)
  const dismiss = progressToast('Saving frame…')
  try {
    const blob = await enqueue(() => renderStill(project, time, width, height, 'image/png'))
    downloadFile(blob, name)
    dismiss()
    toast(`Saved ${name} (${width} × ${height})`)
  } catch (error) {
    console.error('Save frame failed', error)
    dismiss()
    toast('The frame could not be drawn, so nothing was downloaded. Try again in a moment.')
  } finally {
    if (get().dialog !== 'export') releaseStills()
  }
}

/**
 * Downloads the project's frame at `time` (default: the playhead) as a PNG at the project's full size, drawn by the
 * same compositor as the preview and export. A request while a frame is being saved joins that save.
 */
export function saveFrame(time: Seconds = get().playhead): Promise<void> {
  saving ??= downloadFrame(time).finally(() => (saving = null))
  return saving
}

// The palette is loaded on first open, so it can't watch for its own opening.
let paletteOpenedAt: Seconds = get().playhead
useUi.subscribe((s, prev) => {
  if (s.paletteOpen && !prev.paletteOpen) paletteOpenedAt = s.playhead
})

/** Save frame from the command palette: the frame when the palette opened, as playback may have moved on since. */
export function saveFrameFromPalette(): Promise<void> {
  return saveFrame(paletteOpenedAt)
}
