/**
 * The preview's side of the render worker (render.worker.ts): draws preview frames on the canvas the main thread moved
 * here (startPreviewWorker in renderHost.ts). Video frames come with each request from the main thread's <video>
 * elements; images and fonts are read through the main thread's media source, which may generate files (sample media).
 */
import type { Asset, Project, Seconds } from '../model/types.ts'
import { videoTextureKey, WebGLCompositor } from './compositor.ts'
import { BridgedFrameProvider, type BridgedVideo } from './frames.ts'
import type { MediaFileSource } from './types.ts'

export interface PreviewRenderRequest {
  time: Seconds
  size: { width: number; height: number }
  /** Top-level project fields that changed since the last request (the whole project the first time). */
  project?: Partial<Project>
  /** Changes to the project's analysis since the last request, when `project` does not carry it whole. */
  analysis?: AnalysisPatch[]
  videos: BridgedVideo[]
  /** Return the drawn frame as an image. */
  capture?: boolean
  /** Reply only once the GPU has drawn the frame (a still), not when it is queued. */
  untilDrawn?: boolean
  /** Time the frame's drawing, for drawnMs(), without holding up the reply. */
  measure?: boolean
}

/** A change below the project's analysis: the new value at `path`, or its removal. */
export interface AnalysisPatch {
  path: string[]
  value?: unknown
  remove?: true
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The changes from one project analysis to the next, down to each asset's own fields (`audio.<id>.sections`). Posting
 * a message copies everything in it, so a section edit then sends the song's sections, not its feature arrays again.
 */
export function analysisPatches(from: Project['analysis'], to: Project['analysis']): AnalysisPatch[] {
  const patches: AnalysisPatch[] = []
  const diff = (a: unknown, b: unknown, path: string[], depth: number) => {
    if (a === b) return
    if (depth === 0 || !isRecord(a) || !isRecord(b)) {
      patches.push({ path, value: b })
      return
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key in b) diff(a[key], b[key], [...path, key], depth - 1)
      else patches.push({ path: [...path, key], remove: true })
    }
  }
  diff(from, to, [], 3)
  return patches
}

/** `analysis` with the patches applied. Only the objects on their paths are copied; the rest keep their identity. */
export function applyAnalysisPatches(
  analysis: Project['analysis'] | undefined,
  patches: AnalysisPatch[],
): Project['analysis'] {
  const apply = (node: unknown, path: string[], patch: AnalysisPatch): unknown => {
    const [key, ...rest] = path
    if (key === undefined) return patch.value
    const copy = { ...(isRecord(node) ? node : {}) }
    if (patch.remove && !rest.length) delete copy[key]
    else copy[key] = apply(copy[key], rest, patch)
    return copy
  }
  let root: unknown = analysis
  for (const patch of patches) root = apply(root, patch.path, patch)
  return root as Project['analysis']
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

/**
 * How long a reply waits for the GPU to draw an `untilDrawn` frame. Longer than `gpuIdle()`'s 1 s default because the
 * page asks for it only for its first still, whose first-use shader compiles can take seconds on a slow GPU, and replying
 * early shows a black canvas.
 */
const UNTIL_DRAWN_WAIT_MS = 5000

export class WorkerPreview {
  private readonly compositor: WebGLCompositor
  private readonly frames: BridgedFrameProvider
  private project: Project | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** The time of the last frame drawn with `measure`, from the start of its rendering until the GPU finished it. */
  private drawn: Promise<number | null> = Promise.resolve(null)

  constructor(canvas: OffscreenCanvas, media: MediaFileSource, preserveDrawingBuffer: boolean) {
    this.frames = new BridgedFrameProvider(media)
    this.compositor = new WebGLCompositor({ canvas, frames: this.frames, media, preserveDrawingBuffer })
  }

  /**
   * Takes a video frame of a render still to come (`staged`), sent as soon as its seek ended, and uploads it in turn
   * with the frames queued before, while the page waits for the render's other frames. The render draws with exactly
   * the frames staged for it, so a frame never mixes layers of different requests.
   */
  stage(video: BridgedVideo): void {
    const { frame, key, version } = video
    if (!frame || version === undefined) return
    this.frames.stage(video)
    this.queue = this.queue
      .then(async () => {
        await this.drawn
        await this.compositor.gpuIdle()
        this.compositor.stage(videoTextureKey(key), frame, version)
      })
      .catch(() => undefined)
  }

  /** Draws one frame. Requests run one at a time in arrival order, each with its own video frames. */
  render(request: PreviewRenderRequest): Promise<ImageBitmap | null> {
    const run = this.queue.then(() => this.draw(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async draw(request: PreviewRenderRequest): Promise<ImageBitmap | null> {
    if (request.project) this.project = { ...this.project, ...request.project } as Project
    if (request.analysis && this.project)
      this.project = {
        ...this.project,
        analysis: applyAnalysisPatches(this.project.analysis, request.analysis),
      }
    this.frames.set(request.videos)
    const project = this.project
    if (!project) return null
    // More GL work on a GPU still busy with the last frame would stall this thread and show frames late.
    await this.drawn
    await this.compositor.gpuIdle()
    const started = performance.now()
    await this.compositor.render(project, request.time, { size: request.size })
    // In the drawing's task: without preserveDrawingBuffer, the frame is gone once the task ends.
    const bitmap = request.capture ? createImageBitmap(this.compositor.canvas) : null
    // The canvas shows the frame only once the GPU has drawn it: replying earlier would tell the page a still is on
    // screen while the canvas is still blank.
    if (request.untilDrawn) await this.compositor.gpuIdle(UNTIL_DRAWN_WAIT_MS)
    // Only this wait polls the frame's fence, and the next frame waits for it above: otherwise the poll could find the
    // next frame's fence and count that frame too.
    else if (request.measure)
      this.drawn = this.compositor
        .gpuIdle(UNTIL_DRAWN_WAIT_MS)
        .then(() => (this.compositor.gpuBusy() ? null : performance.now() - started))
    return bitmap
  }

  /** How long the last frame drawn with `measure` took to draw, once the GPU has drawn it; null when unknown. */
  drawnMs(): Promise<number | null> {
    return this.drawn
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
