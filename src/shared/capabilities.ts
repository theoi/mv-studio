export interface WebGpuInfo {
  available: boolean
  /** Adapter vendor/architecture when the browser exposes it. */
  adapter?: string
  shaderF16: boolean
}

export interface RuntimeCapabilities {
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  hardwareConcurrency: number
  /** Thread count to give WASM runtimes (ONNX Runtime, etc.); 1 when SharedArrayBuffer is unavailable. */
  wasmThreads: number
  webCodecs: boolean
  webgl2: boolean
  webgpu: WebGpuInfo
  opfs: boolean
}

interface GpuAdapterLike {
  features: { has(name: string): boolean }
  info?: { vendor?: string; architecture?: string }
}
interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: 'high-performance' | 'low-power'
  }): Promise<GpuAdapterLike | null>
}

/**
 * WASM thread count for ML runtimes. Leaves one core for the UI and caps at 8, where the pilots saw no further gain.
 */
export function wasmThreadCount(
  isolated = globalThis.crossOriginIsolated === true,
  cores = globalThis.navigator?.hardwareConcurrency ?? 1,
): number {
  if (!isolated) return 1
  return Math.max(1, Math.min(8, cores - 1))
}

async function detectWebGpu(): Promise<WebGpuInfo> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) return { available: false, shaderF16: false }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { available: false, shaderF16: false }
    const info = adapter.info
    const name = [info?.vendor, info?.architecture].filter(Boolean).join(' ')
    return { available: true, adapter: name || undefined, shaderF16: adapter.features.has('shader-f16') }
  } catch {
    return { available: false, shaderF16: false }
  }
}

function detectWebgl2(): boolean {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1).getContext('webgl2') !== null
    if (typeof document !== 'undefined') return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
  return false
}

let cached: Promise<RuntimeCapabilities> | undefined

/** Detects browser capabilities once per page or worker; safe to call from anywhere. */
export function detectCapabilities(): Promise<RuntimeCapabilities> {
  cached ??= (async () => {
    const isolated = globalThis.crossOriginIsolated === true
    const cores = globalThis.navigator?.hardwareConcurrency ?? 1
    return {
      crossOriginIsolated: isolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hardwareConcurrency: cores,
      wasmThreads: wasmThreadCount(isolated, cores),
      webCodecs: typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined',
      webgl2: detectWebgl2(),
      webgpu: await detectWebGpu(),
      opfs: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    }
  })()
  return cached
}
