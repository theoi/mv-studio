import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCapabilities } from '../../../src/shared/capabilities.ts'
import type * as SharedModels from '../../../src/shared/models.ts'

const h = vi.hoisted(() => ({ caps: null as unknown as RuntimeCapabilities, cached: new Set<string>() }))

vi.mock('../../../src/shared/capabilities.ts', () => ({ detectCapabilities: async () => h.caps }))
vi.mock('../../../src/shared/models.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModels>()),
  modelCache: {
    has: async (url: string) => h.cached.has(url),
    remove: async (url: string) => {
      h.cached.delete(url)
    },
    clear: async () => h.cached.clear(),
    usage: async () => ({ entries: h.cached.size, bytes: 0 }),
  },
}))

const { refreshModels, removeModel, useModels, visionDownloadBytes } =
  await import('../../../src/app/state/models.ts')

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
const NO_WEBGPU = device(false)
const WEBGPU_F16 = device(true, true)
const WEBGPU_F32 = device(true)

const DEPTH =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx'
const DEPTH_MAIN = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx'
const CLIP =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523/onnx'
const CLIP_MAIN = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx'

const row = (id: string) => useModels.getState().models.find((m) => m.id === id)!

beforeEach(() => {
  h.cached.clear()
})

describe('Settings › This device', () => {
  it('lists the size of the weights this device downloads', async () => {
    const sizes = async (caps: RuntimeCapabilities) => {
      h.caps = caps
      await refreshModels()
      return ['depth', 'matte', 'tagger', 'cutout', 'stems'].map((id) => row(id).bytes)
    }
    const others = [row('cutout').bytes, row('stems').bytes]
    expect(await sizes(NO_WEBGPU)).toEqual([27_258_801, 6_632_188, 89_117_001 + 64_504_507, ...others])
    expect(await sizes(WEBGPU_F16)).toEqual([49_642_442, 12_984_781, 176_080_659 + 127_339_794, ...others])
    expect(await sizes(WEBGPU_F32)).toEqual([99_060_839, 25_888_640, 351_685_709 + 254_058_553, ...others])
  })

  it('shows a model as on this device when the weights for this device are cached', async () => {
    h.cached.add(`${DEPTH}/model_quantized.onnx`)
    h.caps = WEBGPU_F16
    await refreshModels()
    expect(useModels.getState().cached?.depth).toBe('none')
    h.cached.add(`${DEPTH_MAIN}/model_fp16.onnx`)
    await refreshModels()
    expect(useModels.getState().cached?.depth).toBe('all')
    h.caps = NO_WEBGPU
    h.cached.delete(`${DEPTH}/model_quantized.onnx`)
    await refreshModels()
    expect(useModels.getState().cached?.depth).toBe('none')
  })

  it('removes a model’s weights for every device, and the copies cached under their former URLs', async () => {
    const depth = [
      `${DEPTH}/model_quantized.onnx`,
      `${DEPTH}/model_fp16.onnx`,
      `${DEPTH}/model.onnx`,
      `${DEPTH_MAIN}/model_quantized.onnx`,
      `${DEPTH_MAIN}/model.onnx`,
    ]
    for (const url of [...depth, `${CLIP}/vision_model_fp16.onnx`]) h.cached.add(url)
    h.caps = WEBGPU_F16
    await refreshModels()
    await removeModel('depth')
    expect([...h.cached]).toEqual([`${CLIP}/vision_model_fp16.onnx`])
  })
})

describe('the cost lines', () => {
  it('count what this device still has to download', async () => {
    h.caps = WEBGPU_F32
    expect(await visionDownloadBytes('depth')).toBe(99_060_839)
    h.cached.add(`${DEPTH}/model.onnx`)
    expect(await visionDownloadBytes('depth')).toBe(0)
    h.caps = NO_WEBGPU
    expect(await visionDownloadBytes('depth')).toBe(27_258_801)
    h.caps = WEBGPU_F16
    h.cached.add(`${CLIP_MAIN}/vision_model_fp16.onnx`)
    expect(await visionDownloadBytes('tagger')).toBe(127_339_794)
  })
})
