import { describe, expect, it } from 'vitest'
import type { RuntimeCapabilities } from '../../../../src/shared/capabilities.ts'
import {
  allVisionModelFiles,
  transformersFiles,
  visionDtype,
  visionModelBytes,
  visionModelFiles,
} from '../../../../src/vision/runtime/models.ts'

function device(webgpu: boolean, shaderF16 = false): RuntimeCapabilities {
  return {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    hardwareConcurrency: 4,
    wasmThreads: 4,
    autoWasmThreads: 4,
    webCodecs: true,
    webgl2: true,
    webgpu: { available: webgpu, shaderF16 },
    opfs: true,
  }
}

const weights = (files: { url: string }[]) =>
  files.map((f) => f.url.slice(f.url.indexOf('/onnx/') + 1)).filter((p) => p.startsWith('onnx/'))

describe('vision model weights per device', () => {
  it('are q8 without WebGPU, fp16 on WebGPU with shader-f16 and fp32 on WebGPU without it', () => {
    expect(visionDtype(device(false))).toBe('q8')
    expect(visionDtype(device(false, true))).toBe('q8')
    expect(visionDtype(device(true, true))).toBe('fp16')
    expect(visionDtype(device(true))).toBe('fp32')
  })

  it('are the pinned files of that dtype, and what the device downloads adds up from them', () => {
    expect(weights(visionModelFiles('depth', 'q8'))).toEqual(['onnx/model_quantized.onnx'])
    expect(weights(visionModelFiles('depth', 'fp16'))).toEqual(['onnx/model_fp16.onnx'])
    expect(weights(visionModelFiles('depth', 'fp32'))).toEqual(['onnx/model.onnx'])
    expect(weights(visionModelFiles('tagger', 'fp16'))).toEqual([
      'onnx/vision_model_fp16.onnx',
      'onnx/text_model_fp16.onnx',
    ])
    expect(visionModelBytes('depth', 'q8')).toBe(27_258_801)
    expect(visionModelBytes('depth', 'fp16')).toBe(49_642_442)
    expect(visionModelBytes('depth', 'fp32')).toBe(99_060_839)
    expect(visionModelBytes('matte', 'fp16')).toBe(12_984_781)
    expect(visionModelBytes('tagger', 'fp32')).toBe(351_685_709 + 254_058_553)
    const pinned = new Map(transformersFiles().map((f) => [f.url, f]))
    for (const dtype of ['q8', 'fp16', 'fp32'] as const)
      for (const f of visionModelFiles('depth', dtype)) expect(f).toEqual(pinned.get(f.url))
  })

  it('leave the MediaPipe models alone: they have one file on every device', () => {
    expect(visionModelFiles('cutout', 'fp16')).toEqual(visionModelFiles('cutout', 'q8'))
    expect(visionModelBytes('picker', 'fp32')).toBe(6_227_884)
  })

  it('are all listed for removing a model', () => {
    expect(weights(allVisionModelFiles('depth')).sort()).toEqual([
      'onnx/model.onnx',
      'onnx/model_fp16.onnx',
      'onnx/model_quantized.onnx',
    ])
    expect(allVisionModelFiles('cutout')).toEqual(visionModelFiles('cutout'))
  })
})
