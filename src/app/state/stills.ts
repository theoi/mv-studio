import { useEffect, useSyncExternalStore } from 'react'
import { PreviewController } from '../../engine/preview.ts'
import type { Project, Seconds } from '../../model/index.ts'
import { appMedia } from './media.ts'

/*
 * Still frames of projects that are not on the main preview, such as export outputs laid out for another format.
 * One offscreen engine preview renders them one at a time; results are kept as object URLs by key.
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

async function render(project: Project, time: Seconds, width: number, height: number): Promise<Blob | null> {
  controller ??= new PreviewController({
    canvas: document.createElement('canvas'),
    media: appMedia,
    preserveDrawingBuffer: true,
  })
  const preview = controller
  preview.setViewport(width, height, 1)
  preview.seek(time)
  preview.setProject(project)
  await preview.rendered()
  return new Promise((resolve) => preview.canvas.toBlob(resolve, 'image/jpeg', 0.86))
}

function requestStill(key: string, project: Project, time: Seconds, width: number, height: number): void {
  if (urls.has(key) || pending.has(key)) return
  pending.add(key)
  queue = queue
    .then(() => render(project, time, width, height))
    .then(
      (blob) => {
        if (blob) store(key, URL.createObjectURL(blob))
      },
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
