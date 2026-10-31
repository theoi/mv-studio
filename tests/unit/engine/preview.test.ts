import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Compositor from '../../../src/engine/compositor.ts'
import type * as Frames from '../../../src/engine/frames.ts'
import type * as RenderHost from '../../../src/engine/renderHost.ts'
import { PreviewController } from '../../../src/engine/preview.ts'
import { createProject } from '../../../src/model/factory.ts'

const compositor = vi.hoisted(() => ({
  render: vi.fn<() => Promise<void>>(),
  gpuBusy: () => false,
  gpuIdle: () => Promise.resolve(),
  dispose: vi.fn(),
  canvas: {},
}))
const frames = vi.hoisted(() => ({
  setPlaying: vi.fn(),
  warm: vi.fn(),
  dispose: vi.fn(),
  beginFrame: vi.fn(),
  endFrame: vi.fn(),
}))
const worker = vi.hoisted(() => ({ ms: (_size: { width: number; height: number }): number => 0 }))

vi.mock('../../../src/engine/renderHost.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof RenderHost>()),
  startPreviewWorker: vi.fn(async () => ({
    render: (request: { size: { width: number; height: number } }) =>
      new Promise((resolve) => setTimeout(() => resolve(null), worker.ms(request.size))),
    capture: vi.fn(),
    failure: () => null,
    dispose: vi.fn(),
  })),
}))

vi.mock('../../../src/engine/compositor.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Compositor>()),
  WebGLCompositor: vi.fn(function WebGLCompositor() {
    return compositor
  }),
}))
vi.mock('../../../src/engine/frames.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Frames>()),
  VideoElementFrameProvider: vi.fn(function VideoElementFrameProvider() {
    return frames
  }),
}))

/** A main-thread preview that has started drawing its first frame. */
function open(): PreviewController {
  const preview = new PreviewController({
    canvas: {} as HTMLCanvasElement,
    media: { getFile: async () => new Blob() },
    renderer: 'main',
  })
  preview.setViewport(320, 180, 1)
  preview.setProject(createProject())
  expect(compositor.render).toHaveBeenCalledTimes(1)
  return preview
}

describe('closing a preview', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('lets the frame being drawn finish before it stops the renderer', async () => {
    vi.useFakeTimers()
    let finish = () => {}
    compositor.render.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    open().dispose()
    await vi.advanceTimersByTimeAsync(1)
    expect(compositor.dispose).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(compositor.dispose).toHaveBeenCalledTimes(1)
    expect(frames.dispose).toHaveBeenCalledTimes(1)
  })

  it('stops a renderer stuck on a frame shortly after, instead of keeping it forever', async () => {
    vi.useFakeTimers()
    compositor.render.mockReturnValue(new Promise<void>(() => {}))
    open().dispose()
    await vi.advanceTimersByTimeAsync(1900)
    expect(compositor.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(compositor.dispose).toHaveBeenCalledTimes(1)
    expect(frames.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses a capture once closed, without drawing', async () => {
    compositor.render.mockResolvedValue(undefined)
    const preview = open()
    await preview.rendered()
    preview.dispose()
    await expect(preview.captureFrame()).rejects.toThrow('The preview is closed')
    expect(compositor.render).toHaveBeenCalledTimes(1)
  })
})

describe('scrubbing on the render worker', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('lowers the resolution like playback when stills come too slowly, and settles at full size', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('VideoFrame', class {})
    // A GPU-bound still: 120 ms at 1280 × 720, less at smaller sizes.
    worker.ms = ({ width, height }) => (120 * width * height) / (1280 * 720)
    const preview = new PreviewController({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      media: { getFile: async () => new Blob() },
      renderer: 'worker',
    })
    preview.setViewport(1280, 720, 1)
    preview.setProject(createProject())
    await vi.advanceTimersByTimeAsync(500)
    expect(preview.stats()).toMatchObject({ worker: true, width: 1280, scale: 1 })
    // A drag along the ruler: a seek every 16 ms for 3 s.
    let lowest = 1
    for (let t = 0; t < 3000; t += 16) {
      preview.seek(t / 1000)
      await vi.advanceTimersByTimeAsync(16)
      lowest = Math.min(lowest, preview.stats().scale)
    }
    expect(lowest).toBeLessThan(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(preview.stats()).toMatchObject({ scale: 1, width: 1280 })
    preview.dispose()
  })
})

describe('scrubbing on the main thread', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not take the waits for the pointer in a slow drag for slow stills', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    compositor.render.mockResolvedValue(undefined)
    const preview = open()
    await vi.advanceTimersByTimeAsync(100)
    // Steps 40 ms apart keep the drag going (each comes soon after the last still), and each still draws at once.
    let lowest = 1
    for (let t = 0; t < 3000; t += 40) {
      preview.seek(t / 1000)
      await vi.advanceTimersByTimeAsync(40)
      lowest = Math.min(lowest, preview.stats().scale)
    }
    expect(compositor.render.mock.calls.length).toBeGreaterThan(50)
    expect(lowest).toBe(1)
    preview.dispose()
  })
})
