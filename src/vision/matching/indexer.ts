import type { EmbeddingModel, OnnxBackend } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { decodeContainer, encodeContainer } from '../runtime/container.ts'
import { fitSize, iterateFrames, prefetch, sampleTimes, type FrameSource } from '../runtime/frames.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { ClipVisionIndex, GrayImage, Size, TimeRange } from '../types.ts'
import { createMotionAnalyzer } from './motion.ts'
import { frameHubness } from './ranking.ts'

export interface ClipIndexOptions extends TaskOptions {
  range?: TimeRange
  /** Embedded frames per second, default 1. */
  embedFps?: number
  /** Motion samples per second, default 4. */
  motionFps?: number
  batchSize?: number
}

export interface ClipIndexDeps {
  onnx: OnnxBackend
  model: EmbeddingModel
  /** Small luma version of a frame; does not consume the bitmap. */
  toGray: (bitmap: ImageBitmap, size: Size) => GrayImage
  /** Text embeddings of `REFERENCE_PROMPTS` for the same model (hubness correction). */
  referenceVectors: () => Promise<Float32Array[]>
}

export const CLIP_INDEX_VERSION = 1
/** CLIP/SigLIP preprocessing resizes the short side to 224, so decoding larger is wasted work. */
const EMBED_SHORT_SIDE = 224
const MOTION_SIDE = 64

/**
 * Builds the footage-matching index of a clip: image embeddings at ~1 fps, their hubness
 * (similarity to generic prompts, subtracted at query time), and a motion/energy analysis
 * at a higher rate. Decoding overlaps with inference.
 */
export async function indexClip(
  deps: ClipIndexDeps,
  source: FrameSource,
  options: ClipIndexOptions = {},
): Promise<ClipVisionIndex> {
  const { signal } = options
  const range = options.range ?? { start: 0, end: source.duration }
  const motionFps = options.motionFps ?? 4
  const embedEvery = Math.max(1, Math.round(motionFps / (options.embedFps ?? 1)))
  const batchSize = options.batchSize ?? 8
  const times = sampleTimes(range.start, range.end, motionFps)
  if (!times.length) throw new JobError('invalid-input', 'The clip range is empty.')
  const shortSide = Math.min(source.width, source.height)
  const maxSide = Math.ceil(
    (Math.max(source.width, source.height) * Math.min(shortSide, EMBED_SHORT_SIDE)) / shortSide,
  )
  const graySize = fitSize(source, MOTION_SIDE)
  const progress = createProgress(options.onProgress)
  const motion = createMotionAnalyzer({ fps: motionFps })
  const embedTimes: number[] = []
  const chunks: Float32Array[] = []
  let dim = 0
  let batch: ImageBitmap[] = []
  let inFlight: Promise<void> | null = null
  let peakLuma: number | undefined

  const flush = async () => {
    if (!batch.length) return
    // Wait before taking the batch: if the previous call failed, these frames stay in `batch` and get closed.
    await inFlight
    const bitmaps = batch
    batch = []
    inFlight = deps.onnx
      .embedImages({ bitmaps, model: deps.model }, { signal, transfer: bitmaps })
      .then((res) => {
        dim = res.dim
        chunks.push(res.data)
      })
  }

  try {
    progress(0, 'loading-model')
    let i = 0
    const frames = prefetch(iterateFrames(source, times, { maxSide, signal }), 2, (f) => f.bitmap.close())
    for await (const { t, bitmap } of frames) {
      motion.push(t, deps.toGray(bitmap, graySize))
      // At the decoded size, not the motion's 64 px, where a small light on black is sampled away.
      peakLuma = Math.max(
        peakLuma ?? 0,
        peak(deps.toGray(bitmap, { width: bitmap.width, height: bitmap.height })),
      )
      if (i % embedEvery === 0) {
        embedTimes.push(t)
        batch.push(bitmap)
        if (batch.length >= batchSize) await flush()
      } else {
        bitmap.close()
      }
      i++
      progress((0.95 * i) / times.length, 'indexing')
    }
    if (signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
    await flush()
    await inFlight
    const embeddings = concat(chunks)
    if (!dim || embeddings.length !== embedTimes.length * dim)
      throw new JobError('internal', 'Frame embeddings are incomplete.')
    const refs = await deps.referenceVectors()
    progress(1, 'done')
    return {
      version: 1,
      mediaId: source.mediaId,
      duration: source.duration,
      model: deps.model,
      dim,
      times: embedTimes,
      embeddings,
      hubness: frameHubness(embeddings, dim, refs),
      motion: { ...motion.finish(), ...(peakLuma === undefined ? {} : { peakLuma }) },
    }
  } catch (err) {
    for (const b of batch) b.close()
    await Promise.resolve(inFlight).catch(() => undefined)
    throw visionError(err, 'internal')
  }
}

/** Frames the fast blank check samples from a clip: enough that a clip with content is rarely black at all of them. */
export const BLANK_CHECK_FRAMES = 8

/**
 * The brightest luma in the clip's first frame and `frames` frames spread evenly over it, at the size the matching
 * index decodes. One frame for a still. A clip that shows nothing is black in every one, so this flags it long before
 * the matching index is built.
 *
 * With `enough`, it stops at the first frame at least that bright: one bright frame settles that a clip shows
 * something, and each frame after the first costs a seek that decodes from the keyframe before it (up to about a second
 * for a 4K clip). Most clips show something in their first frame.
 */
export async function samplePeakLuma(
  deps: Pick<ClipIndexDeps, 'toGray'>,
  source: FrameSource,
  options: { frames?: number; enough?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const n = source.duration > 0 ? (options.frames ?? BLANK_CHECK_FRAMES) : 0
  const times = [0, ...Array.from({ length: n }, (_, i) => (source.duration * (i + 0.5)) / n)]
  const shortSide = Math.min(source.width, source.height)
  const maxSide = Math.ceil(
    (Math.max(source.width, source.height) * Math.min(shortSide, EMBED_SHORT_SIDE)) / shortSide,
  )
  let max = 0
  try {
    for await (const { bitmap } of iterateFrames(source, times, {
      maxSide,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      max = Math.max(max, peak(deps.toGray(bitmap, { width: bitmap.width, height: bitmap.height })))
      bitmap.close()
      if (options.enough !== undefined && max >= options.enough) break
    }
  } catch (err) {
    throw visionError(err, 'decode')
  }
  if (options.signal?.aborted) throw new JobError('cancelled', 'The task was cancelled.')
  return max
}

function peak(gray: GrayImage): number {
  let max = 0
  for (const v of gray.data) if (v > max) max = v
  return max
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export function serializeClipIndex(index: ClipVisionIndex): Promise<Uint8Array> {
  const { embeddings, ...meta } = index
  return encodeContainer(meta, [
    new Uint8Array(embeddings.buffer, embeddings.byteOffset, embeddings.byteLength),
  ])
}

export async function deserializeClipIndex(bytes: Uint8Array): Promise<ClipVisionIndex> {
  const { meta, chunks } = await decodeContainer<Omit<ClipVisionIndex, 'embeddings'>>(bytes)
  const raw = chunks[0]
  if (meta.version !== 1 || !raw || raw.byteLength !== meta.times.length * meta.dim * 4)
    throw new Error('Unsupported or inconsistent clip index')
  const embeddings = new Float32Array(raw.byteLength / 4)
  new Uint8Array(embeddings.buffer).set(raw)
  return { ...meta, embeddings }
}
