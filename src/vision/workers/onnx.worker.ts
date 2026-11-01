/// <reference lib="webworker" />
import type * as Transformers from '@huggingface/transformers'
import type { EmbeddingModel } from '../backends.ts'
import { JobError } from '../../shared/jobs.ts'
import { visionError } from '../errors.ts'
import {
  loadTransformers,
  pinRevision,
  registerModelFiles,
  withModelProgress,
} from '../../shared/transformers.ts'
import {
  hfRepo,
  hfRevision,
  transformersFiles,
  transformersRevisions,
  VISION_MODELS,
} from '../runtime/models.ts'
import { exposeWorker, transfer, type WorkerCallContext } from '../../shared/worker.ts'
import { detectCapabilities } from '../../shared/capabilities.ts'
import { preferredDevice, type ModelDescriptor } from '../../shared/models.ts'
import type { Mask } from '../types.ts'

type T = typeof Transformers
type Device = { device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'fp16' | 'q8' }

const WASM: Device = { device: 'wasm', dtype: 'q8' }
let gpuDevice: Promise<Device | null> | null = null

for (const [repo, revision] of transformersRevisions()) pinRevision(repo, revision)
registerModelFiles(transformersFiles())

function webgpuDevice(): Promise<Device | null> {
  gpuDevice ??= detectCapabilities().then((caps): Device | null =>
    preferredDevice(caps) === 'webgpu'
      ? { device: 'webgpu', dtype: caps.webgpu.shaderF16 ? 'fp16' : 'fp32' }
      : null,
  )
  return gpuDevice
}

/** Loads a model on WebGPU if possible, else WASM q8; remembers a WebGPU failure per model. */
const gpuFailed = new Set<string>()
async function load<M>(
  key: string,
  create: (d: Device) => Promise<M>,
): Promise<{ model: M; device: Device }> {
  const gpu = gpuFailed.has(key) ? null : await webgpuDevice()
  if (gpu) {
    try {
      return { model: await create(gpu), device: gpu }
    } catch {
      gpuFailed.add(key)
    }
  }
  return { model: await create(WASM), device: WASM }
}

function assertFinite(data: ArrayLike<number>, what: string): void {
  for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 997))) {
    if (!Number.isFinite(data[i]!)) throw new JobError('internal', `${what} produced invalid values`)
  }
}

let canvas: OffscreenCanvas | null = null
function rawImage(Tx: T, bitmap: ImageBitmap): Transformers.RawImage {
  canvas ??= new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0)
  return Tx.RawImage.fromCanvas(canvas)
}

function toUint8(values: Float32Array | number[], invert = false): Uint8Array {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  const out = new Uint8Array(values.length)
  const scale = max > min ? 255 / (max - min) : 0
  for (let i = 0; i < values.length; i++) {
    const v = Math.round((values[i]! - min) * scale)
    out[i] = invert ? 255 - v : v
  }
  return out
}

// --- models -----------------------------------------------------------------

interface ImageModel {
  processor: Transformers.Processor
  model: Transformers.PreTrainedModel
  device: Device
}

const imageModels = new Map<string, Promise<ImageModel>>()
function imageModel(
  key: string,
  descriptor: ModelDescriptor,
  cls: 'auto' | 'clipVision' | 'siglipVision',
): Promise<ImageModel> {
  let p = imageModels.get(key)
  if (!p) {
    p = (async () => {
      const Tx = await loadTransformers()
      const Model =
        cls === 'clipVision'
          ? Tx.CLIPVisionModelWithProjection
          : cls === 'siglipVision'
            ? Tx.SiglipVisionModel
            : Tx.AutoModel
      const [repo, revision] = [hfRepo(descriptor), hfRevision(descriptor)]
      const [processor, loaded] = await Promise.all([
        Tx.AutoProcessor.from_pretrained(repo, { revision }),
        load(key, (d) => Model.from_pretrained(repo, { revision, device: d.device, dtype: d.dtype })),
      ])
      return { processor, model: loaded.model, device: loaded.device }
    })().catch((err: unknown) => {
      imageModels.delete(key)
      throw visionError(err, 'model-load')
    })
    imageModels.set(key, p)
  }
  return p
}

interface TextModel {
  tokenizer: Transformers.PreTrainedTokenizer
  model: Transformers.PreTrainedModel
}
const textModels = new Map<string, Promise<TextModel>>()
function textModel(key: EmbeddingModel): Promise<TextModel> {
  let p = textModels.get(key)
  if (!p) {
    p = (async () => {
      const Tx = await loadTransformers()
      const [repo, revision] = [hfRepo(EMBEDDING_MODELS[key]), hfRevision(EMBEDDING_MODELS[key])]
      const Model = key === 'clipB32' ? Tx.CLIPTextModelWithProjection : Tx.SiglipTextModel
      const [tokenizer, loaded] = await Promise.all([
        Tx.AutoTokenizer.from_pretrained(repo, { revision }),
        load(`${key}:text`, (d) =>
          Model.from_pretrained(repo, { revision, device: d.device, dtype: d.dtype }),
        ),
      ])
      return { tokenizer, model: loaded.model }
    })().catch((err: unknown) => {
      textModels.delete(key)
      throw visionError(err, 'model-load')
    })
    textModels.set(key, p)
  }
  return p
}

const EMBEDDING_MODELS: Record<EmbeddingModel, ModelDescriptor> = {
  clipB32: VISION_MODELS.clipB32,
  siglipB16: VISION_MODELS.siglipB16,
}

function setSize(processor: Transformers.Processor, size: Record<string, number>): void {
  const ip = (processor as unknown as { image_processor?: { size: unknown } }).image_processor
  if (ip) ip.size = size
}

function normalizeRows(data: Float32Array, rows: number, dim: number): Float32Array {
  const out = new Float32Array(rows * dim)
  for (let r = 0; r < rows; r++) {
    let s = 0
    for (let k = 0; k < dim; k++) s += data[r * dim + k]! ** 2
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0
    for (let k = 0; k < dim; k++) out[r * dim + k] = data[r * dim + k]! * inv
  }
  return out
}

// Serializes inference so concurrent calls don't fight over the shared ONNX thread pool.
let queue: Promise<unknown> = Promise.resolve()
function serialized<R>(fn: () => Promise<R>): Promise<R> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

const api = {
  depth(input: { bitmap: ImageBitmap; shortSide: number }, ctx: WorkerCallContext) {
    return serialized(async () => {
      const { bitmap } = input
      try {
        if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
        const Tx = await loadTransformers()
        const m = await withModelProgress(ctx.progress, () =>
          imageModel('depth', VISION_MODELS.depthAnythingSmall, 'auto'),
        )
        // DPT resizes so the short side matches and keeps aspect (multiple of 14).
        setSize(m.processor, { height: input.shortSide, width: input.shortSide })
        const inputs = await m.processor(rawImage(Tx, bitmap))
        const { predicted_depth } = (await m.model(inputs)) as { predicted_depth: Transformers.Tensor }
        const dims = predicted_depth.dims
        const height = dims[dims.length - 2]!
        const width = dims[dims.length - 1]!
        const values = predicted_depth.data as Float32Array
        assertFinite(values, 'Depth estimation')
        // Depth Anything predicts relative inverse depth: larger means nearer.
        const data = toUint8(values)
        return transfer({ width, height, data }, [data.buffer])
      } catch (err) {
        throw visionError(err, 'internal')
      } finally {
        bitmap.close()
      }
    })
  },

  matte(input: { bitmap: ImageBitmap; shortSide: number }, ctx: WorkerCallContext) {
    return serialized(async () => {
      const { bitmap } = input
      try {
        if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
        const Tx = await loadTransformers()
        const m = await withModelProgress(ctx.progress, () =>
          imageModel('modnet', VISION_MODELS.modnet, 'auto'),
        )
        setSize(m.processor, { shortest_edge: input.shortSide })
        const inputs = await m.processor(rawImage(Tx, bitmap))
        const out = (await m.model({ input: inputs.pixel_values })) as Record<string, Transformers.Tensor>
        const tensor = out.output ?? Object.values(out)[0]!
        const dims = tensor.dims
        const height = dims[dims.length - 2]!
        const width = dims[dims.length - 1]!
        const values = tensor.data as Float32Array
        assertFinite(values, 'Matting')
        const data = new Uint8Array(values.length)
        for (let i = 0; i < values.length; i++)
          data[i] = Math.max(0, Math.min(255, Math.round(values[i]! * 255)))
        const mask: Mask = { width, height, data }
        return transfer(mask, [data.buffer])
      } catch (err) {
        throw visionError(err, 'internal')
      } finally {
        bitmap.close()
      }
    })
  },

  embedImages(input: { bitmaps: ImageBitmap[]; model: EmbeddingModel }, ctx: WorkerCallContext) {
    return serialized(async () => {
      try {
        if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
        if (!input.bitmaps.length) return { dim: 0, data: new Float32Array(0) }
        const Tx = await loadTransformers()
        const isClip = input.model === 'clipB32'
        const m = await withModelProgress(ctx.progress, () =>
          imageModel(
            `${input.model}:vision`,
            EMBEDDING_MODELS[input.model],
            isClip ? 'clipVision' : 'siglipVision',
          ),
        )
        const inputs = await m.processor(input.bitmaps.map((b) => rawImage(Tx, b)))
        const out = (await m.model(inputs)) as Record<string, Transformers.Tensor>
        const t = isClip ? out.image_embeds! : out.pooler_output!
        const [rows, dim] = [t.dims[0]!, t.dims[t.dims.length - 1]!]
        const raw = t.data as Float32Array
        assertFinite(raw, 'Image embedding')
        const data = normalizeRows(raw, rows, dim)
        return transfer({ dim, data }, [data.buffer])
      } catch (err) {
        throw visionError(err, 'internal')
      } finally {
        for (const b of input.bitmaps) b.close()
      }
    })
  },

  embedTexts(input: { texts: string[]; model: EmbeddingModel }, ctx: WorkerCallContext) {
    return serialized(async () => {
      try {
        if (ctx.signal.aborted) throw new JobError('cancelled', 'The task was cancelled.')
        if (!input.texts.length) return { dim: 0, data: new Float32Array(0) }
        const m = await withModelProgress(ctx.progress, () => textModel(input.model))
        const isClip = input.model === 'clipB32'
        const tokens = m.tokenizer(
          input.texts,
          isClip
            ? { padding: true, truncation: true }
            : { padding: 'max_length', max_length: 64, truncation: true },
        )
        const out = (await m.model(tokens)) as Record<string, Transformers.Tensor>
        const t = isClip ? out.text_embeds! : out.pooler_output!
        const [rows, dim] = [t.dims[0]!, t.dims[t.dims.length - 1]!]
        const raw = t.data as Float32Array
        assertFinite(raw, 'Text embedding')
        const data = normalizeRows(raw, rows, dim)
        return transfer({ dim, data }, [data.buffer])
      } catch (err) {
        throw visionError(err, 'internal')
      }
    })
  },
}

export type OnnxWorkerApi = typeof api
exposeWorker(api)
