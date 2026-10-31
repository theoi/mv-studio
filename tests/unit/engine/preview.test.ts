import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Compositor from '../../../src/engine/compositor.ts'
import type * as Frames from '../../../src/engine/frames.ts'
import { PreviewController } from '../../../src/engine/preview.ts'
import { createProject } from '../../../src/model/factory.ts'

const compositor = vi.hoisted(() => ({
  render: vi.fn<() => Promise<void>>(),
  gpuBusy: () => false,
  dispose: vi.fn(),
  canvas: {},
}))
const frames = vi.hoisted(() => ({ setPlaying: vi.fn(), warm: vi.fn(), dispose: vi.fn() }))

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
