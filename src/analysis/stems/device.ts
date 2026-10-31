import type { RuntimeCapabilities } from '../../shared/capabilities.ts'
import { preferredDevice, type ModelDevice } from '../../shared/models.ts'

/** WebGPU on a hardware adapter, else WASM threads: a software adapter (SwiftShader) is about 50 times slower. */
export function stemDevice(caps: RuntimeCapabilities): ModelDevice {
  return /swiftshader/i.test(caps.webgpu.adapter ?? '') ? 'wasm' : preferredDevice(caps)
}
