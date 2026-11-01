import { JobError } from '../../shared/jobs.ts'
import type { Size } from '../types.ts'

/**
 * Where vision tasks get video frames from. The media area provides the production
 * implementation (mediabunny/WebCodecs); `createVideoElementSource` is a fallback.
 */
export interface FrameSource {
  readonly mediaId: string
  readonly width: number
  readonly height: number
  /** Seconds. */
  readonly duration: number
  /** Nominal frames per second. */
  readonly frameRate: number
  /** Frame at media time `t`, scaled so the longer side is at most `maxSide`. The caller closes it. */
  frameAt(t: number, options?: { maxSide?: number }): Promise<ImageBitmap>
  /** Optional fast path for many ascending times (sequential decode). */
  frames?(
    times: readonly number[],
    options?: { maxSide?: number; signal?: AbortSignal },
  ): AsyncIterable<{ t: number; bitmap: ImageBitmap }>
}

export async function* iterateFrames(
  source: FrameSource,
  times: readonly number[],
  options: { maxSide?: number; signal?: AbortSignal } = {},
): AsyncIterable<{ t: number; bitmap: ImageBitmap }> {
  if (source.frames) {
    yield* source.frames(times, options)
    return
  }
  for (const t of times) {
    if (options.signal?.aborted) return
    const bitmap = await source.frameAt(t, options.maxSide !== undefined ? { maxSide: options.maxSide } : {})
    yield { t, bitmap }
  }
}

/** Evenly spaced sample times in [start, end), at most `fps` per second, never empty for a non-empty range. */
export function sampleTimes(start: number, end: number, fps: number): number[] {
  if (!(end > start) || !(fps > 0)) return []
  const step = 1 / fps
  const count = Math.max(1, Math.floor((end - start) * fps + 1e-9))
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(start + i * step)
  return times
}

/** Scales `size` so its longer side is at most `maxSide`, keeping aspect, rounding to even pixels. */
export function fitSize(size: Size, maxSide: number): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= maxSide) return { width: size.width, height: size.height }
  const s = maxSide / longest
  const even = (v: number) => Math.max(2, Math.round((v * s) / 2) * 2)
  return { width: even(size.width), height: even(size.height) }
}

/**
 * Keeps up to `ahead` items decoded in advance, so frame decoding overlaps with the
 * consumer's inference. Items left over when the consumer stops early are passed to `dispose`.
 */
export async function* prefetch<T>(
  source: AsyncIterable<T>,
  ahead: number,
  dispose?: (item: T) => void,
): AsyncIterable<T> {
  const it = source[Symbol.asyncIterator]()
  const queue: Array<Promise<IteratorResult<T>>> = []
  const fill = () => {
    while (queue.length < Math.max(1, ahead)) queue.push(it.next())
  }
  let completed = false
  try {
    fill()
    while (true) {
      const next = await queue.shift()!
      if (next.done) {
        completed = true
        return
      }
      fill()
      yield next.value
    }
  } finally {
    if (!completed) {
      const pending = queue.splice(0)
      // Pull requests already issued must settle before return() is allowed on async generators.
      const settled = await Promise.allSettled(pending)
      for (const s of settled) if (s.status === 'fulfilled' && !s.value.done) dispose?.(s.value.value)
      await it.return?.()
    }
  }
}

/**
 * Frame source backed by an HTMLVideoElement (main thread only), for when no WebCodecs decoder from src/media is
 * available. Seeks per frame, so it is slower than sequential decoding but works for any format Chrome plays.
 */
export async function createVideoElementSource(
  src: string | Blob,
  mediaId: string,
  options: { frameRate?: number } = {},
): Promise<FrameSource & { dispose(): void }> {
  const video = document.createElement('video')
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = url
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new JobError('decode', `Couldn’t load video ${mediaId}`)), {
      once: true,
    })
  })
  let queue: Promise<unknown> = Promise.resolve()
  const seek = (t: number) =>
    new Promise<void>((resolve, reject) => {
      const target = Math.min(Math.max(0, t), Math.max(0, video.duration - 1e-3))
      if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return resolve()
      const done = () => {
        video.removeEventListener('error', fail)
        resolve()
      }
      const fail = () => {
        video.removeEventListener('seeked', done)
        reject(new JobError('decode', `Couldn’t seek video ${mediaId} to ${t.toFixed(3)} s`))
      }
      video.addEventListener('seeked', done, { once: true })
      video.addEventListener('error', fail, { once: true })
      video.currentTime = target
    })
  return {
    mediaId,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    frameRate: options.frameRate ?? 30,
    frameAt(t, o) {
      // One seek at a time: concurrent seeks on one element resolve with the wrong frame.
      const run = queue.then(async () => {
        await seek(t)
        const size = fitSize({ width: video.videoWidth, height: video.videoHeight }, o?.maxSide ?? Infinity)
        return createImageBitmap(video, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'medium',
        })
      })
      queue = run.catch(() => undefined)
      return run
    },
    dispose() {
      video.removeAttribute('src')
      video.load()
      if (typeof src !== 'string') URL.revokeObjectURL(url)
    },
  }
}
