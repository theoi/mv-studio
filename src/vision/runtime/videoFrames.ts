import { createWorkerClient, type WorkerClient } from '../../shared/worker.ts'
import type { FramesWorkerApi } from '../workers/frames.worker.ts'
import { createVideoElementSource, type FrameSource } from './frames.ts'

let client: WorkerClient<FramesWorkerApi> | null = null
let opened = 0

/**
 * Frames of a video file for thumbnails: decoded and scaled with WebCodecs in a worker, so the page only receives the
 * small frame. A file the worker cannot read (a container or codec it does not know) gets a <video> element on the
 * page instead.
 */
export async function openVideoFrames(
  file: Blob,
  mediaId: string,
  options: { frameRate?: number } = {},
): Promise<FrameSource & { dispose(): void }> {
  client ??= createWorkerClient<FramesWorkerApi>(
    () =>
      new Worker(new URL('../workers/frames.worker.ts', import.meta.url), {
        type: 'module',
        name: 'vision-frames',
      }),
  )
  const worker = client
  const id = `${mediaId}#${++opened}`
  let meta: { width: number; height: number; duration: number }
  try {
    meta = await worker.call('open', { id, file })
  } catch {
    return createVideoElementSource(file, mediaId, options)
  }
  return {
    mediaId,
    ...meta,
    frameRate: options.frameRate ?? 30,
    frameAt: (t, o) =>
      worker.call('frame', { id, t, ...(o?.maxSide !== undefined ? { maxSide: o.maxSide } : {}) }),
    dispose() {
      worker.call('close', { id }).catch(() => undefined)
    },
  }
}
