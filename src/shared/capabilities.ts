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
  /**
   * Thread count to give WASM runtimes (ONNX Runtime, etc.): the automatic count, lowered to the user's limit from
   * Settings › This device; 1 when SharedArrayBuffer is unavailable.
   */
  wasmThreads: number
  /** The automatic thread count, without the user's limit. */
  autoWasmThreads: number
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
 * WASM thread count for ML runtimes. Leaves one core for the UI and caps at 8, where the pilots saw no further gain;
 * `limit` (the user's setting) lowers it further.
 */
export function wasmThreadCount(
  isolated = globalThis.crossOriginIsolated === true,
  cores = globalThis.navigator?.hardwareConcurrency ?? 1,
  limit: number | null = null,
): number {
  if (!isolated) return 1
  const auto = Math.max(1, Math.min(8, cores - 1))
  return limit ? Math.max(1, Math.min(auto, Math.floor(limit))) : auto
}

// The thread limit lives in IndexedDB rather than localStorage because workers, where the models run, read it too.
const PREFS_DB = 'mv-studio-prefs'
const PREFS_STORE = 'prefs'
const THREAD_LIMIT_KEY = 'wasmThreadLimit'

function prefsRequest(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(PREFS_DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(PREFS_STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const req = request(db.transaction(PREFS_STORE, mode).objectStore(PREFS_STORE))
      req.onsuccess = () => {
        db.close()
        resolve(req.result)
      }
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    }
  })
}

/** The user's CPU thread limit for AI (Settings › This device), or null for automatic. */
export async function loadThreadLimit(): Promise<number | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const value = await prefsRequest('readonly', (s) => s.get(THREAD_LIMIT_KEY))
    return typeof value === 'number' && value >= 1 ? value : null
  } catch {
    return null
  }
}

/**
 * Saves the thread limit (null: automatic). Runtimes fix their thread pool when they start, so it applies to AI that
 * starts afterwards, in new workers.
 */
export async function saveThreadLimit(limit: number | null): Promise<void> {
  await prefsRequest('readwrite', (s) =>
    limit ? s.put(limit, THREAD_LIMIT_KEY) : s.delete(THREAD_LIMIT_KEY),
  )
  cached = undefined
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

function drawsWebgl2(canvas: () => OffscreenCanvas | HTMLCanvasElement): boolean {
  try {
    const gl = canvas().getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    // Browsers keep only a few contexts alive at once; this one has answered.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

let webgl2: boolean | undefined

/**
 * Whether this page or worker can draw with WebGL2, which the preview, exports, VJ mode and the 3D camera need: on an
 * OffscreenCanvas (the render worker's) or a page canvas (the main-thread fallback). Chrome without a usable GPU (a
 * virtual machine, a remote desktop, graphics acceleration turned off, a blocklisted driver) offers neither, unless
 * started with --enable-unsafe-swiftshader, which Playwright adds to every launch. Checked once, as each check makes a
 * context.
 */
export function webgl2Available(): boolean {
  webgl2 ??=
    (typeof OffscreenCanvas !== 'undefined' && drawsWebgl2(() => new OffscreenCanvas(1, 1))) ||
    (typeof document !== 'undefined' && drawsWebgl2(() => document.createElement('canvas')))
  return webgl2
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
      wasmThreads: wasmThreadCount(isolated, cores, await loadThreadLimit()),
      autoWasmThreads: wasmThreadCount(isolated, cores),
      webCodecs: typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined',
      webgl2: webgl2Available(),
      webgpu: await detectWebGpu(),
      opfs: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    }
  })()
  return cached
}
