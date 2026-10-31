/// <reference lib="webworker" />
import {
  FaceDetector,
  ImageSegmenter,
  InteractiveSegmenterLegacy,
  ObjectDetector,
} from '@mediapipe/tasks-vision'
import type {
  Delegate,
  FaceObservation,
  FrameAnalysis,
  FrameAnalysisRequest,
  PersonDetection,
  PersonModel,
  SelectRequest,
  TrackFrameRequest,
  TrackFrameResult,
} from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import { floatToMask, resizeMask } from '../mask/ops.ts'
import { PERSON_MIN_SCORE } from '../mask/suitability.ts'
import { createMediaPipeTask, mediapipeModel } from '../runtime/loaders.ts'
import { withModelProgress } from '../../shared/transformers.ts'
import { VISION_MODELS } from '../runtime/models.ts'
import { exposeWorker, transfer, type WorkerCallContext } from '../../shared/worker.ts'
import {
  createMaskTrackBuilder,
  preferHq,
  type MaskTrackBuildConfig,
  type MaskTrackBuilder,
} from '../segmentation/trackBuilder.ts'
import type { GrayImage, Mask, PackedMaskTrack, RgbaImage } from '../types.ts'

let segmenter: ImageSegmenter | null = null
let segmenterKey = ''
let faceDetector: FaceDetector | null = null
let personDetector: ObjectDetector | null = null
let selector: InteractiveSegmenterLegacy | null = null
let lastTimestamp = 0
let timestampOffset = 0
let config: { model: PersonModel; delegate: Delegate } = { model: 'selfieLandscape', delegate: 'CPU' }

async function getSegmenter(): Promise<ImageSegmenter> {
  const key = `${config.model}:${config.delegate}`
  if (segmenter && segmenterKey === key) return segmenter
  segmenter?.close()
  segmenter = null
  const modelAssetBuffer = await mediapipeModel(VISION_MODELS[config.model])
  const create = (delegate: Delegate) =>
    createMediaPipeTask((fileset) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    )
  try {
    segmenter = await create(config.delegate)
  } catch (err) {
    if (config.delegate !== 'GPU') throw err
    segmenter = await create('CPU')
  }
  segmenterKey = key
  lastTimestamp = 0
  timestampOffset = 0
  return segmenter
}

async function getFaceDetector(): Promise<FaceDetector> {
  if (faceDetector) return faceDetector
  const modelAssetBuffer = await mediapipeModel(VISION_MODELS.faceShortRange)
  faceDetector ??= await createMediaPipeTask((fileset) =>
    FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    }),
  )
  return faceDetector
}

async function getPersonDetector(): Promise<ObjectDetector> {
  if (personDetector) return personDetector
  const modelAssetBuffer = await mediapipeModel(VISION_MODELS.personDetector)
  personDetector ??= await createMediaPipeTask((fileset) =>
    ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: PERSON_MIN_SCORE,
      categoryAllowlist: ['person'],
      maxResults: 10,
    }),
  )
  return personDetector
}

async function getSelector(): Promise<InteractiveSegmenterLegacy> {
  if (selector) return selector
  const modelAssetBuffer = await mediapipeModel(VISION_MODELS.magicTouch)
  // The newer InteractiveSegmenter class fails to create its engine with magic_touch in 1.2.0.
  selector ??= await createMediaPipeTask((fileset) =>
    InteractiveSegmenterLegacy.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer, delegate: 'CPU' },
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }),
  )
  return selector
}

function personMaskFrom(result: {
  confidenceMasks?: Array<{ width: number; height: number; getAsFloat32Array(): Float32Array; close(): void }>
}): Mask {
  const masks = result.confidenceMasks
  if (!masks?.length) throw new JobError('internal', 'The segmenter returned no mask.')
  const { width, height } = masks[0]!
  let mask: Mask
  if (masks.length === 1) {
    mask = floatToMask(masks[0]!.getAsFloat32Array(), width, height)
  } else {
    // Multiclass: category 0 is background; everything else (hair, skin, clothes...) is the person.
    const bg = masks[0]!.getAsFloat32Array()
    const person = new Float32Array(bg.length)
    for (let i = 0; i < bg.length; i++) person[i] = 1 - bg[i]!
    mask = floatToMask(person, width, height)
  }
  for (const m of masks) m.close()
  return mask
}

let canvas: OffscreenCanvas | null = null
function pixels(bitmap: ImageBitmap): RgbaImage {
  const { width, height } = bitmap
  canvas ??= new OffscreenCanvas(width, height)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  return { width, height, data: ctx.getImageData(0, 0, width, height).data }
}

function luma(rgba: RgbaImage): GrayImage {
  const n = rgba.width * rgba.height
  const out = new Uint8Array(n)
  const d = rgba.data
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (d[j]! * 77 + d[j + 1]! * 150 + d[j + 2]! * 29) >> 8
  return { width: rgba.width, height: rgba.height, data: out }
}

async function detectFaces(bitmap: ImageBitmap): Promise<FaceObservation[]> {
  const det = await getFaceDetector()
  const { detections } = det.detect(bitmap)
  return detections
    .filter((d) => d.boundingBox)
    .map((d): FaceObservation => {
      const b = d.boundingBox!
      const x = Math.max(0, b.originX / bitmap.width)
      const y = Math.max(0, b.originY / bitmap.height)
      return {
        box: {
          x,
          y,
          width: Math.min(1 - x, b.width / bitmap.width),
          height: Math.min(1 - y, b.height / bitmap.height),
        },
        score: d.categories[0]?.score ?? 0,
      }
    })
}

async function detectPeople(bitmap: ImageBitmap): Promise<PersonDetection[]> {
  const det = await getPersonDetector()
  return det
    .detect(bitmap)
    .detections.filter((d) => d.boundingBox)
    .map((d): PersonDetection => {
      const b = d.boundingBox!
      const x = Math.max(0, b.originX / bitmap.width)
      const y = Math.max(0, b.originY / bitmap.height)
      return {
        box: {
          x,
          y,
          width: Math.min(1 - x, b.width / bitmap.width),
          height: Math.min(1 - y, b.height / bitmap.height),
        },
        score: d.categories[0]?.score ?? 0,
      }
    })
}

async function segmentPerson(bitmap: ImageBitmap, timestampMs: number): Promise<Mask> {
  const seg = await getSegmenter()
  const result = seg.segmentForVideo(bitmap, nextTimestamp(timestampMs))
  try {
    return personMaskFrom(result)
  } finally {
    result.close()
  }
}

const tracks = new Map<number, MaskTrackBuilder>()
let nextTrackId = 1

function trackBuilder(id: number): MaskTrackBuilder {
  const builder = tracks.get(id)
  if (!builder) throw new JobError('invalid-input', `Unknown or finished mask track ${id}.`)
  return builder
}

function nextTimestamp(requested: number): number {
  // VIDEO mode rejects non-increasing timestamps; seeks backwards must still work.
  let ts = requested + timestampOffset
  if (ts <= lastTimestamp) {
    timestampOffset += lastTimestamp - ts + 1
    ts = lastTimestamp + 1
  }
  lastTimestamp = ts
  return ts
}

const api = {
  async configure(input: { model: PersonModel; delegate: Delegate }, ctx: WorkerCallContext) {
    config = { ...input }
    await withModelProgress(ctx.progress, getSegmenter)
  },

  async resetStream(_input: null) {
    timestampOffset = lastTimestamp + 1000
  },

  async analyze(req: FrameAnalysisRequest, ctx: WorkerCallContext) {
    const { bitmap } = req
    try {
      const out: FrameAnalysis = {}
      const list: Transferable[] = []
      if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
      if (req.mask) {
        const mask = await segmentPerson(bitmap, req.timestampMs)
        out.mask = req.maskSize ? resizeMask(mask, req.maskSize.width, req.maskSize.height) : mask
        list.push(out.mask.data.buffer)
      }
      if (req.faces) out.faces = await withModelProgress(ctx.progress, () => detectFaces(bitmap))
      if (req.people) out.people = await withModelProgress(ctx.progress, () => detectPeople(bitmap))
      if (req.gray || req.rgba) {
        const rgba = pixels(bitmap)
        if (req.gray) {
          out.gray = luma(rgba)
          list.push(out.gray.data.buffer)
        }
        if (req.rgba) {
          out.rgba = {
            width: rgba.width,
            height: rgba.height,
            data: new Uint8Array(rgba.data.buffer.slice(0)),
          }
          list.push(out.rgba.data.buffer as ArrayBuffer)
        }
      }
      return transfer(out, list)
    } catch (err) {
      throw visionError(err, 'internal')
    } finally {
      bitmap.close()
    }
  },

  async select(input: SelectRequest, ctx: WorkerCallContext) {
    const { bitmap, points } = input
    try {
      if (!points.length)
        throw new JobError('invalid-input', 'At least one point is needed to select an object.')
      const sel = await withModelProgress(ctx.progress, getSelector)
      const roi = points.length === 1 ? { keypoint: points[0]! } : { scribble: points }
      const result = sel.segment(bitmap, roi)
      let mask: Mask
      try {
        mask = personMaskFrom(result)
      } finally {
        result.close()
      }
      if (input.maskSize) mask = resizeMask(mask, input.maskSize.width, input.maskSize.height)
      return transfer(mask, [mask.data.buffer])
    } catch (err) {
      throw visionError(err, 'internal')
    } finally {
      bitmap.close()
    }
  },

  async beginTrack(config: MaskTrackBuildConfig, ctx: WorkerCallContext): Promise<{ id: number }> {
    await withModelProgress(ctx.progress, getSegmenter)
    timestampOffset = lastTimestamp + 1000
    const id = nextTrackId++
    tracks.set(id, createMaskTrackBuilder(config))
    return { id }
  },

  async pushTrackFrame(req: TrackFrameRequest, ctx: WorkerCallContext): Promise<TrackFrameResult> {
    const { bitmap } = req
    try {
      const builder = trackBuilder(req.id)
      if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
      const standard = await segmentPerson(bitmap, req.timestampMs)
      const { mask, usedHq } = req.hq ? preferHq(standard, req.hq) : { mask: standard, usedHq: false }
      const faces = req.faces ? await withModelProgress(ctx.progress, () => detectFaces(bitmap)) : undefined
      const people = req.people
        ? await withModelProgress(ctx.progress, () => detectPeople(bitmap))
        : undefined
      const rgba = pixels(bitmap)
      const stats = builder.push({ mask, gray: luma(rgba), rgba })
      return { ...stats, usedHq, ...(faces ? { faces } : {}), ...(people ? { people } : {}) }
    } catch (err) {
      throw visionError(err, 'internal')
    } finally {
      bitmap.close()
    }
  },

  async endTrack(input: { id: number }) {
    const track: PackedMaskTrack = trackBuilder(input.id).finish()
    tracks.delete(input.id)
    return transfer(
      track,
      track.packed.map((p) => p.buffer as ArrayBuffer),
    )
  },

  async cancelTrack(input: { id: number }): Promise<void> {
    tracks.delete(input.id)
  },
}

export type SegmentationWorkerApi = typeof api
exposeWorker(api)
