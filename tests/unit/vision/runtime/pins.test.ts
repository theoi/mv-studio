import { describe, expect, it } from 'vitest'
import type { ModelFile } from '../../../../src/shared/models.ts'
import {
  hfRepo,
  hfRevision,
  MEDIAPIPE_WASM_BASE,
  transformersFiles,
  VISION_MODELS,
} from '../../../../src/vision/runtime/models.ts'

const HF_PINNED = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/([0-9a-f]{40})\/(.+)$/
const MP_PINNED = /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/[\w/]+\/\d+\/[\w.]+\.tflite$/

const descriptorFiles = Object.values(VISION_MODELS).flatMap((m) => Object.values(m.files) as ModelFile[])
const pinned = [...descriptorFiles, ...transformersFiles()]
const transformersModels = [
  VISION_MODELS.depthAnythingSmall,
  VISION_MODELS.modnet,
  VISION_MODELS.clipB32,
  VISION_MODELS.siglipB16,
]

describe('vision model downloads', () => {
  it('load from a fixed revision or version, with a checksum', () => {
    expect(pinned.length).toBeGreaterThan(descriptorFiles.length)
    for (const file of pinned) {
      expect(HF_PINNED.test(file.url) || MP_PINNED.test(file.url), file.url).toBe(true)
      expect(file.sha256, file.url).toMatch(/^[0-9a-f]{64}$/)
      expect(file.bytes, file.url).toBeGreaterThan(0)
    }
    expect(MEDIAPIPE_WASM_BASE).toMatch(/@\d+\.\d+\.\d+\/wasm$/)
  })

  it('pin every file Transformers.js loads, for WASM (q8) and WebGPU (fp16 or fp32)', () => {
    const urls = new Set(transformersFiles().map((f) => f.url))
    for (const model of transformersModels) {
      const base = `https://huggingface.co/${hfRepo(model)}/resolve/${hfRevision(model)}/`
      const graphs = Object.values(model.files as Record<string, ModelFile>).map((f) =>
        HF_PINNED.exec(f.url)![2]!.replace(/_quantized\.onnx$/, ''),
      )
      const needed = ['config.json', 'preprocessor_config.json']
      if (graphs.some((g) => g.includes('text_model'))) needed.push('tokenizer.json', 'tokenizer_config.json')
      for (const g of graphs) needed.push(`${g}_quantized.onnx`, `${g}_fp16.onnx`, `${g}.onnx`)
      for (const path of needed) expect(urls.has(base + path), base + path).toBe(true)
    }
  })

  it('move copies cached from the moving path that served the same bytes, instead of downloading again', () => {
    for (const file of pinned) {
      const hf = HF_PINNED.exec(file.url)
      const moving = hf
        ? file.url.replace(`/resolve/${hf[1]}/`, '/resolve/main/')
        : file.url.replace('/1/', '/latest/')
      if (file.url === VISION_MODELS.magicTouch.files.model.url) expect(file.formerUrls).toBeUndefined()
      else expect(file.formerUrls, file.url).toEqual([moving])
    }
  })
})
