import type {
  FrameAnalysis,
  FrameAnalysisRequest,
  OnnxBackend,
  SegmentationBackend,
  SelectRequest,
  TrackFrameRequest,
  TrackFrameResult,
} from '../../../../src/vision/backends.ts'
import { JobError } from '../../../../src/shared/jobs.ts'
import {
  createMaskTrackBuilder,
  preferHq,
  type MaskTrackBuildConfig,
  type MaskTrackBuilder,
} from '../../../../src/vision/segmentation/trackBuilder.ts'
import type { FrameSource } from '../../../../src/vision/runtime/frames.ts'
import type { GrayImage, Mask, Size } from '../../../../src/vision/types.ts'

export interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly t: number
  closed: boolean
  close(): void
}

export function fakeBitmap(t: number, size: Size): ImageBitmap {
  const b: FakeBitmap = {
    width: size.width,
    height: size.height,
    t,
    closed: false,
    close() {
      b.closed = true
    },
  }
  return b as unknown as ImageBitmap
}

export function timeOf(bitmap: ImageBitmap): number {
  return (bitmap as unknown as FakeBitmap).t
}

export function fakeSource(opts: {
  duration: number
  frameRate?: number
  width?: number
  height?: number
  mediaId?: string
  failAt?: number
}) {
  const opened: ImageBitmap[] = []
  const source: FrameSource = {
    mediaId: opts.mediaId ?? 'clip-1',
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
    duration: opts.duration,
    frameRate: opts.frameRate ?? 30,
    async frameAt(t, o) {
      if (opts.failAt !== undefined && t >= opts.failAt) throw new JobError('decode', 'bad frame')
      const max = o?.maxSide ?? Math.max(source.width, source.height)
      const s = Math.min(1, max / Math.max(source.width, source.height))
      const b = fakeBitmap(t, { width: Math.round(source.width * s), height: Math.round(source.height * s) })
      opened.push(b)
      return b
    },
  }
  return { source, opened }
}

/** Disc mask whose centre moves with t; used as the "person" of the fake segmenter. */
export function discMask(size: Size, cx: number, cy: number, r: number): Mask {
  const data = new Uint8Array(size.width * size.height)
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++)
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) data[y * size.width + x] = 255
  return { width: size.width, height: size.height, data }
}

export function flatGray(size: Size, value = 100): GrayImage {
  return {
    width: size.width,
    height: size.height,
    data: new Uint8Array(size.width * size.height).fill(value),
  }
}

/**
 * In-process stand-in for the segmentation worker: same track builder, masks from `personAt`.
 */
export function fakeSegmentation(
  personAt: (t: number, size: Size) => Mask = (_t, s) => discMask(s, s.width / 2, s.height / 2, s.height / 4),
) {
  const calls: string[] = []
  const tracks = new Map<number, MaskTrackBuilder>()
  let nextId = 1
  const backend: SegmentationBackend & { calls: string[]; pushed: TrackFrameRequest[] } = {
    calls,
    pushed: [],
    async configure() {
      calls.push('configure')
    },
    async resetStream() {
      calls.push('resetStream')
    },
    async analyze(req: FrameAnalysisRequest): Promise<FrameAnalysis> {
      calls.push('analyze')
      const size = { width: req.bitmap.width, height: req.bitmap.height }
      const t = timeOf(req.bitmap)
      req.bitmap.close()
      return {
        ...(req.mask ? { mask: personAt(t, size) } : {}),
        ...(req.faces ? { faces: [{ box: { x: 0.45, y: 0.3, width: 0.1, height: 0.15 }, score: 0.9 }] } : {}),
        ...(req.gray ? { gray: flatGray(size) } : {}),
      }
    },
    async select(req: SelectRequest): Promise<Mask> {
      calls.push('select')
      req.bitmap.close()
      return {
        width: req.maskSize?.width ?? 1,
        height: req.maskSize?.height ?? 1,
        data: new Uint8Array((req.maskSize?.width ?? 1) * (req.maskSize?.height ?? 1)),
      }
    },
    async beginTrack(config: MaskTrackBuildConfig) {
      calls.push('beginTrack')
      const id = nextId++
      tracks.set(id, createMaskTrackBuilder({ ...config, refineFrom: 0 }))
      return { id }
    },
    async pushTrackFrame(req: TrackFrameRequest): Promise<TrackFrameResult> {
      calls.push('pushTrackFrame')
      backend.pushed.push(req)
      const builder = tracks.get(req.id)
      if (!builder) throw new JobError('invalid-input', 'unknown track')
      const size = { width: req.bitmap.width, height: req.bitmap.height }
      const standard = personAt(timeOf(req.bitmap), size)
      req.bitmap.close()
      const { mask, usedHq } = req.hq ? preferHq(standard, req.hq) : { mask: standard, usedHq: false }
      const stats = builder.push({ mask, gray: flatGray(size) })
      return {
        ...stats,
        usedHq,
        ...(req.faces ? { faces: [{ box: { x: 0.45, y: 0.3, width: 0.1, height: 0.15 }, score: 0.9 }] } : {}),
      }
    },
    async endTrack({ id }) {
      calls.push('endTrack')
      const track = tracks.get(id)!.finish()
      tracks.delete(id)
      return track
    },
    async cancelTrack({ id }) {
      calls.push('cancelTrack')
      tracks.delete(id)
    },
  }
  return backend
}

/** Text/image embeddings from a lookup; unknown texts get a deterministic pseudo-random vector. */
export function fakeOnnx(
  opts: {
    dim?: number
    imageVector?: (t: number) => Float32Array
    textVector?: (text: string) => Float32Array
    matte?: (bitmap: ImageBitmap) => Mask
  } = {},
) {
  const dim = opts.dim ?? 8
  const calls = { embedImages: [] as number[], embedTexts: [] as string[][], matte: [] as number[] }
  const unit = (v: Float32Array) => {
    const n = Math.hypot(...v)
    return v.map((x) => x / (n || 1))
  }
  const hashVector = (s: string) => {
    const v = new Float32Array(dim)
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    for (let i = 0; i < dim; i++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
      v[i] = ((h >>> 0) / 4294967296) * 2 - 1
    }
    return unit(v)
  }
  const backend: OnnxBackend & { calls: typeof calls } = {
    calls,
    async depth() {
      throw new Error('not used')
    },
    async matte({ bitmap }) {
      calls.matte.push(timeOf(bitmap))
      const m = opts.matte?.(bitmap) ?? { width: 4, height: 4, data: new Uint8Array(16) }
      bitmap.close()
      return m
    },
    async embedImages({ bitmaps }) {
      calls.embedImages.push(bitmaps.length)
      const data = new Float32Array(bitmaps.length * dim)
      bitmaps.forEach((b, i) => {
        data.set(unit(opts.imageVector?.(timeOf(b)) ?? hashVector(`img${timeOf(b)}`)), i * dim)
        b.close()
      })
      return { dim, data }
    },
    async embedTexts({ texts }) {
      calls.embedTexts.push([...texts])
      const data = new Float32Array(texts.length * dim)
      texts.forEach((t, i) => data.set(unit(opts.textVector?.(t) ?? hashVector(t)), i * dim))
      return { dim, data }
    },
  }
  return backend
}
