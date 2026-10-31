import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Compositor from '../../../src/engine/compositor.ts'
import type * as Frames from '../../../src/engine/frames.ts'
import { WorkerPreview } from '../../../src/engine/previewWorker.ts'
import { createProject } from '../../../src/model/factory.ts'

/** A GPU that takes the next of `times` (ms) per frame, one frame after the other, behind the compositor's fence calls. */
const gpu = vi.hoisted(() => ({ times: [] as number[], busyUntil: 0, renders: [] as number[] }))

vi.mock('../../../src/engine/compositor.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Compositor>()),
  WebGLCompositor: vi.fn(function WebGLCompositor() {
    const busy = () => performance.now() < gpu.busyUntil
    return {
      canvas: {},
      render: async () => {
        gpu.renders.push(performance.now())
        gpu.busyUntil = Math.max(performance.now(), gpu.busyUntil) + (gpu.times.shift() ?? 0)
      },
      gpuBusy: busy,
      gpuIdle: async (timeoutMs = 1000) => {
        const until = performance.now() + timeoutMs
        while (busy() && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 1))
      },
      dispose: vi.fn(),
    }
  }),
}))
vi.mock('../../../src/engine/frames.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Frames>()),
  BridgedFrameProvider: vi.fn(function BridgedFrameProvider() {
    return { set: vi.fn(), dispose: vi.fn() }
  }),
}))

function open(): WorkerPreview {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  gpu.busyUntil = 0
  gpu.renders = []
  return new WorkerPreview({} as OffscreenCanvas, { getFile: async () => new Blob() }, false)
}

const request = (time: number, extra: { measure?: boolean; untilDrawn?: boolean } = {}) => ({
  time,
  size: { width: 1280, height: 720 },
  project: createProject(),
  videos: [],
  ...extra,
})

describe('the worker preview timing a still', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replies once the still is queued, and times it from the start of its rendering until the GPU finishes it', async () => {
    const preview = open()
    // The frame before keeps the GPU busy for 100 ms; the still takes 300 ms.
    gpu.times = [100, 300]
    void preview.render(request(1))
    const start = performance.now()
    let repliedAt = -1
    void preview.render(request(2, { measure: true })).then(() => (repliedAt = performance.now() - start))
    await vi.advanceTimersByTimeAsync(150)
    expect(repliedAt).toBeGreaterThanOrEqual(100)
    expect(repliedAt).toBeLessThan(110)
    let ms: number | null = null
    void preview.drawnMs().then((v) => (ms = v))
    await vi.advanceTimersByTimeAsync(400)
    expect(ms).toBeGreaterThanOrEqual(300)
    expect(ms).toBeLessThan(310)
  })

  it('draws the next frame only after the measured one, and gives no time for a GPU that does not finish', async () => {
    const preview = open()
    gpu.times = [6000]
    await preview.render(request(1, { measure: true }))
    void preview.render(request(2))
    await vi.advanceTimersByTimeAsync(4000)
    expect(gpu.renders).toHaveLength(1)
    let ms: number | null = -1
    void preview.drawnMs().then((v) => (ms = v))
    await vi.advanceTimersByTimeAsync(2000)
    expect(ms).toBeNull()
    expect(gpu.renders).toHaveLength(2)
  })
})
