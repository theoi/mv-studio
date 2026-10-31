/**
 * The preview's side of the render worker (render.worker.ts): draws preview frames on the canvas the main thread moved
 * here (startPreviewWorker in renderHost.ts). Video frames come with each request from the main thread's <video>
 * elements; images and fonts are read through the main thread's media source, which may generate files (sample media).
 */
import type { Asset, Project, Seconds } from '../model/types.ts'
import { WebGLCompositor } from './compositor.ts'
import { BridgedFrameProvider, type BridgedVideo } from './frames.ts'
import type { MediaFileSource } from './types.ts'

export interface PreviewRenderRequest {
  time: Seconds
  size: { width: number; height: number }
  /** Top-level project fields that changed since the last request (the whole project the first time). */
  project?: Partial<Project>
  videos: BridgedVideo[]
  /** Return the drawn frame as an image. */
  capture?: boolean
}

/** Media port messages: the worker asks for an asset's file, the main thread answers. */
export interface MediaPortRequest {
  id: number
  asset: Asset
}
export type MediaPortResponse = { id: number; file: Blob } | { id: number; error: string }

/** Worker end of the media port. */
export function portMedia(port: MessagePort): MediaFileSource {
  let nextId = 1
  const pending = new Map<number, { resolve(file: Blob): void; reject(error: Error): void }>()
  port.onmessage = (event: MessageEvent<MediaPortResponse>) => {
    const msg = event.data
    const request = pending.get(msg.id)
    if (!request) return
    pending.delete(msg.id)
    if ('file' in msg) request.resolve(msg.file)
    else request.reject(new Error(msg.error))
  }
  return {
    getFile: (asset) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        port.postMessage({ id, asset } satisfies MediaPortRequest)
      }),
  }
}

/** Main-thread end of the media port. */
export function serveMedia(port: MessagePort, media: MediaFileSource): void {
  port.onmessage = (event: MessageEvent<MediaPortRequest>) => {
    const { id, asset } = event.data
    media.getFile(asset).then(
      (file) => port.postMessage({ id, file } satisfies MediaPortResponse),
      (error: unknown) =>
        port.postMessage({
          id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies MediaPortResponse),
    )
  }
}

export class WorkerPreview {
  private readonly compositor: WebGLCompositor
  private readonly frames: BridgedFrameProvider
  private project: Project | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(canvas: OffscreenCanvas, media: MediaFileSource, preserveDrawingBuffer: boolean) {
    this.frames = new BridgedFrameProvider(media)
    this.compositor = new WebGLCompositor({ canvas, frames: this.frames, media, preserveDrawingBuffer })
  }

  /** Draws one frame. Requests run one at a time in arrival order, each with its own video frames. */
  render(request: PreviewRenderRequest): Promise<ImageBitmap | null> {
    const run = this.queue.then(() => this.draw(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async draw(request: PreviewRenderRequest): Promise<ImageBitmap | null> {
    if (request.project) this.project = { ...this.project, ...request.project } as Project
    this.frames.set(request.videos)
    const project = this.project
    if (!project) return null
    // More GL work on a GPU still busy with the last frame would stall this thread and show frames late.
    await this.compositor.gpuIdle()
    await this.compositor.render(project, request.time, { size: request.size })
    // In the drawing's task: without preserveDrawingBuffer, the frame is gone once the task ends.
    return request.capture ? createImageBitmap(this.compositor.canvas) : null
  }

  /** The frame drawn last; needs preserveDrawingBuffer. */
  capture(): Promise<ImageBitmap> {
    return this.queue.then(() => createImageBitmap(this.compositor.canvas))
  }

  /** Disposes once the frames already queued are drawn. */
  async stop(): Promise<void> {
    await this.queue
    this.dispose()
  }

  dispose(): void {
    this.compositor.dispose()
    this.frames.dispose()
  }
}
