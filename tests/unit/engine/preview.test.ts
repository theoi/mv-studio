import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Compositor from '../../../src/engine/compositor.ts'
import type * as Frames from '../../../src/engine/frames.ts'
import type * as RenderHost from '../../../src/engine/renderHost.ts'
import { PreviewController } from '../../../src/engine/preview.ts'
import { createProject, createVideoClip } from '../../../src/model/factory.ts'
import type { Asset } from '../../../src/model/types.ts'

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
  prewarm: vi.fn(),
  videoFrame: vi.fn(),
  dispose: vi.fn(),
  beginFrame: vi.fn(),
  endFrame: vi.fn(),
}))
/**
 * The stub render worker. Like the real one, it draws a frame once the GPU has finished the frame before, and replies
 * when the frame is queued, or drawn with `untilDrawn`. `ms` is a frame's GPU time.
 */
const worker = vi.hoisted(() => ({
  ms: (_size: { width: number; height: number }): number => 0,
  gpuFreeAt: 0,
  drawn: Promise.resolve<number | null>(null),
  requests: [] as { at: number; width: number; untilDrawn?: boolean; measure?: boolean }[],
  /** The video frames each request carried, and what it transferred. */
  sent: [] as {
    at: number
    videos: { key: string; frame: unknown; version?: number; staged?: boolean }[]
    transfer: unknown[]
  }[],
  /** Video frames sent ahead of their request. */
  staged: [] as { at: number; key: string; frame: unknown; version?: number }[],
}))

vi.mock('../../../src/engine/renderHost.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof RenderHost>()),
  startPreviewWorker: vi.fn(async () => ({
    render: (
      request: {
        size: { width: number; height: number }
        untilDrawn?: boolean
        measure?: boolean
        videos: { key: string; frame: unknown; version?: number; staged?: boolean }[]
      },
      transfer: unknown[],
    ) => {
      worker.sent.push({ at: performance.now(), videos: request.videos, transfer })
      const now = performance.now()
      const { untilDrawn, measure } = request
      worker.requests.push({ at: now, width: request.size.width, untilDrawn, measure })
      const start = Math.max(now, worker.gpuFreeAt)
      const ms = worker.ms(request.size)
      worker.gpuFreeAt = start + ms
      const at = (time: number) => new Promise<void>((resolve) => setTimeout(resolve, time - now))
      if (measure && !untilDrawn) worker.drawn = at(start + ms).then(() => ms)
      return at(untilDrawn ? start + ms : start).then(() => null)
    },
    stage: (video: { key: string; frame: unknown; version?: number }) =>
      worker.staged.push({ at: performance.now(), ...video }),
    drawnMs: () => worker.drawn,
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
  beforeEach(() => {
    worker.gpuFreeAt = 0
    worker.drawn = Promise.resolve(null)
    worker.requests = []
  })
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
  it('judges afresh when the preview grows during a scrub, instead of keeping what it learned at the old size', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('VideoFrame', class {})
    // 60 ms per still at any size (decoding) until the GPU takes longer: 140 ms at 1920 × 1080.
    worker.ms = ({ width, height }) => Math.max(60, (140 * width * height) / (1920 * 1080))
    const preview = new PreviewController({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      media: { getFile: async () => new Blob() },
      renderer: 'worker',
    })
    preview.setViewport(640, 360, 1)
    preview.setProject(createProject())
    await vi.advanceTimersByTimeAsync(500)
    let time = 0
    const drag = async (ms: number) => {
      let lowest = 1
      for (let t = 0; t < ms; t += 16) {
        preview.seek((time += 16) / 1000)
        await vi.advanceTimersByTimeAsync(16)
        lowest = Math.min(lowest, preview.stats().scale)
      }
      return lowest
    }
    // While small, a smaller size does not help: the step down is undone and not tried again for seconds.
    expect(await drag(1500)).toBeLessThan(1)
    expect(preview.stats()).toMatchObject({ scale: 1, width: 640 })
    preview.setViewport(1920, 1080, 1)
    expect(await drag(2000)).toBeLessThan(1)
    preview.dispose()
  })

  /** A worker preview at 1280 × 720 that has drawn its first frame. */
  async function openWorker(): Promise<PreviewController> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('VideoFrame', class {})
    const preview = new PreviewController({
      canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
      media: { getFile: async () => new Blob() },
      renderer: 'worker',
    })
    preview.setViewport(1280, 720, 1)
    preview.setProject(createProject())
    await vi.advanceTimersByTimeAsync(2000)
    return preview
  }

  /** Starts a drag with seeks `everyMs` apart and returns the lowest scale over its first `ms`. */
  async function dragFrom(preview: PreviewController, time: number, ms: number, everyMs = 16) {
    let lowest = 1
    for (let t = 0; t < ms; t += everyMs) {
      preview.seek(time + t / 1000)
      lowest = Math.min(lowest, preview.stats().scale)
      await vi.advanceTimersByTimeAsync(everyMs)
    }
    return lowest
  }

  it('starts a scrub as small as the full-size stills drawn before it call for, instead of after seconds of slow stills', async () => {
    // A slow GPU: 450 ms per still at 1280 × 720, less at smaller sizes.
    worker.ms = ({ width, height }) => (450 * width * height) / (1280 * 720)
    const preview = await openWorker()
    // A click on the ruler, drawn at full size.
    preview.seek(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(preview.stats()).toMatchObject({ scale: 1, width: 1280 })
    // The drag's third step finds the second still waiting for the GPU: the scrub starts, at the lowest level.
    const sent = worker.requests.length
    expect(await dragFrom(preview, 2, 48)).toBe(0.33)
    await vi.advanceTimersByTimeAsync(2000)
    expect(worker.requests.slice(sent).map((r) => r.width)).toContain(Math.round(1280 * 0.33))
    // Released: the frame settles at full size.
    expect(preview.stats()).toMatchObject({ scale: 1, width: 1280 })
    preview.dispose()
  })

  it('sends the next step of a drag while the full-size still before it is drawing, as without timing it', async () => {
    worker.ms = ({ width, height }) => (450 * width * height) / (1280 * 720)
    const preview = await openWorker()
    const sent = worker.requests.length
    const start = performance.now()
    await dragFrom(preview, 2, 32)
    const steps = worker.requests.slice(sent)
    expect(steps.map((r) => r.at - start)).toEqual([0, 16])
    expect(steps[0]).toMatchObject({ width: 1280, measure: true })
    expect(steps[0]?.untilDrawn).toBeFalsy()
    preview.dispose()
  })

  it('drops a still’s time that arrives after the preview changed size', async () => {
    worker.ms = ({ width, height }) => (450 * width * height) / (1280 * 720)
    const preview = await openWorker()
    preview.seek(1)
    await vi.advanceTimersByTimeAsync(100)
    // Shrinks while that still draws (until 450 ms). The still at the new size is drawn by 562 ms.
    preview.setViewport(640, 360, 1)
    await vi.advanceTimersByTimeAsync(360)
    // A drag starts in between: nothing measured at 640 × 360 yet, so it starts at the level it had.
    expect(await dragFrom(preview, 2, 32)).toBe(1)
    preview.dispose()
  })

  it('starts a scrub after the preview grew from the stills drawn at the new size only', async () => {
    worker.ms = ({ width, height }) => (450 * width * height) / (1280 * 720)
    const preview = await openWorker()
    preview.setViewport(320, 180, 1)
    await vi.advanceTimersByTimeAsync(500)
    preview.seek(1)
    await vi.advanceTimersByTimeAsync(500)
    preview.setViewport(1280, 720, 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(preview.stats()).toMatchObject({ scale: 1, width: 1280 })
    expect(await dragFrom(preview, 2, 48)).toBe(0.33)
    preview.dispose()
  })

  it('does not take a one-off slow still for how fast stills draw', async () => {
    // 20 ms per full-size still, but one still compiles a shader on first use.
    let next = 20
    worker.ms = ({ width, height }) => {
      const ms = next
      next = 20
      return (ms * width * height) / (1280 * 720)
    }
    const preview = await openWorker()
    preview.seek(3)
    await vi.advanceTimersByTimeAsync(500)
    next = 400
    preview.seek(4)
    await vi.advanceTimersByTimeAsync(1000)
    // A capture keeps the GPU busy, so the drag's first step is still waiting for it when the scrub starts.
    next = 300
    preview.captureFrame().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(await dragFrom(preview, 5, 48)).toBe(1)
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

describe('keeping media ready for a transition near the paused playhead', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks for the clip a transition brings back, at the transition’s nearest frame, and for none once far from it', async () => {
    compositor.render.mockResolvedValue(undefined)
    const project = createProject()
    const track = project.tracks.find((t) => t.kind === 'visual')!
    const asset = {
      id: 'v',
      kind: 'video',
      name: 'v.mp4',
      storageKey: 'v',
      duration: 10,
      origin: { type: 'import' },
    } as Asset
    project.assets.v = asset
    const a = createVideoClip({ trackId: track.id, assetId: 'v', start: 0, duration: 4, sourceStart: 2 })
    const b = createVideoClip({ trackId: track.id, assetId: 'v', start: 4, duration: 4 })
    b.transitionIn = { kind: 'fade', duration: 0.5, easing: 'linear' }
    project.clips = { [a.id]: a, [b.id]: b }
    const preview = new PreviewController({
      canvas: {} as HTMLCanvasElement,
      media: { getFile: async () => new Blob() },
      renderer: 'main',
    })
    preview.setViewport(320, 180, 1)
    preview.setProject(project)
    preview.seek(5.1)
    await preview.rendered()
    // At 5.1 only b is on screen; the fade from a ends at 4.5, where a's source is at 2 + 4.5.
    expect(frames.prewarm).toHaveBeenLastCalledWith([
      { asset, sourceTime: expect.closeTo(6.499, 3), key: a.id },
    ])
    preview.seek(1)
    await preview.rendered()
    expect(frames.prewarm).toHaveBeenLastCalledWith([])
    preview.dispose()
  })
})

/** A worker preview of a project where two clips of footage `v` are on screen together from 0 to 4 s. */
async function twoLayers(): Promise<{ preview: PreviewController; lower: string; copy: string }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('VideoFrame', class {})
  vi.stubGlobal('ImageData', class {})
  worker.sent = []
  worker.staged = []
  const project = createProject()
  const asset = {
    id: 'v',
    kind: 'video',
    name: 'v.mp4',
    storageKey: 'v',
    duration: 10,
    origin: { type: 'import' },
  } as Asset
  project.assets.v = asset
  const [visual] = project.tracks
  const upper = { ...visual!, id: 'upper', name: 'Video 2' }
  project.tracks = [upper, ...project.tracks]
  const lower = createVideoClip({ trackId: visual!.id, assetId: 'v', start: 0, duration: 4 })
  const copy = createVideoClip({ trackId: upper.id, assetId: 'v', start: 0, duration: 4 })
  copy.opacity = { value: 0.5 }
  project.clips = { [lower.id]: lower, [copy.id]: copy }
  const preview = new PreviewController({
    canvas: { transferControlToOffscreen: () => ({}) } as unknown as HTMLCanvasElement,
    media: { getFile: async () => new Blob() },
    renderer: 'worker',
  })
  preview.setViewport(640, 360, 1)
  preview.setProject(project)
  return { preview, lower: lower.id, copy: copy.id }
}

describe('sending the render worker a frame two clips share', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('gives each clip its own VideoFrame, so the worker can close one without the other', async () => {
    // The provider gives both clips the same frame, as for two clips showing one frame of the same footage.
    frames.videoFrame.mockResolvedValue({ source: {}, width: 1920, height: 1080 })
    const { preview } = await twoLayers()
    await vi.advanceTimersByTimeAsync(100)
    const sent = worker.staged.map((v) => v.frame)
    expect(sent).toHaveLength(2)
    expect(sent.every(Boolean)).toBe(true)
    expect(sent[0]).not.toBe(sent[1])
    preview.dispose()
  })
})

describe('sending the render worker the frames of a paused frame with several layers', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    frames.videoFrame.mockReset()
  })

  it('sends each layer’s frame as its seek ends, and the render once all are there, naming exactly those frames', async () => {
    // The lower clip's seek ends at 10 ms, its copy's at 50 ms.
    const ids: string[] = []
    frames.videoFrame.mockImplementation(
      (_asset: unknown, _t: number, key: string) =>
        new Promise((resolve) => {
          ids.push(key)
          setTimeout(() => resolve({ source: {}, width: 1920, height: 1080 }), ids.length === 1 ? 10 : 50)
        }),
    )
    const { preview } = await twoLayers()
    await vi.advanceTimersByTimeAsync(30)
    expect(worker.staged.map((v) => v.key)).toEqual([ids[0]])
    expect(worker.sent.filter((s) => s.videos.length)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(40)
    expect(worker.staged.map((v) => v.key)).toEqual(ids)
    const render = worker.sent.find((s) => s.videos.length === 2)!
    expect(render.at).toBeGreaterThanOrEqual(worker.staged[1]!.at)
    expect(render.transfer).toEqual([])
    expect(render.videos.map((v) => [v.key, v.staged, v.frame, v.version])).toEqual(
      worker.staged.map((v) => [v.key, true, null, v.version]),
    )
    expect(new Set(render.videos.map((v) => v.version)).size).toBe(2)
    preview.dispose()
  })

  it('sends playing frames with the render, as there is nothing to wait for', async () => {
    frames.videoFrame.mockResolvedValue({ source: {}, width: 1920, height: 1080, version: 7 })
    const { preview } = await twoLayers()
    await vi.advanceTimersByTimeAsync(100)
    expect(worker.staged).toEqual([])
    const render = worker.sent.find((s) => s.videos.length === 2)!
    expect(render.transfer).toHaveLength(2)
    preview.dispose()
  })
})
