import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Compositor from '../../../src/engine/compositor.ts'
import type { BridgedVideo } from '../../../src/engine/frames.ts'
import type { FrameProvider } from '../../../src/engine/types.ts'
import { WorkerPreview } from '../../../src/engine/previewWorker.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset } from '../../../src/model/types.ts'

/** What the compositor did, in order, and the frame of each clip it drew with. */
const gpu = vi.hoisted(() => ({ log: [] as string[], drawn: [] as Record<string, unknown>[] }))

vi.mock('../../../src/engine/compositor.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Compositor>()),
  WebGLCompositor: vi.fn(function WebGLCompositor(options: { frames: FrameProvider }) {
    return {
      canvas: {},
      stage: (key: string, source: { name: string }, version: number) =>
        gpu.log.push(`stage ${key} ${source.name} ${version}`),
      render: async () => {
        const drawn: Record<string, unknown> = {}
        for (const key of ['a', 'b']) {
          const ref = await options.frames.videoFrame({} as Asset, 0, key)
          drawn[key] = (ref?.source as { name?: string } | undefined)?.name ?? null
        }
        gpu.drawn.push(drawn)
        gpu.log.push('render')
      },
      gpuBusy: () => false,
      gpuIdle: async () => undefined,
      dispose: vi.fn(),
    }
  }),
}))

const frame = (name: string) => ({ name, close: vi.fn() }) as unknown as VideoFrame
const video = (key: string, f: VideoFrame | null, extra: Partial<BridgedVideo> = {}): BridgedVideo => ({
  key,
  frame: f,
  width: 640,
  height: 360,
  ...extra,
})
const ahead = (key: string, version: number) => video(key, null, { version, staged: true })
const request = (time: number, videos: BridgedVideo[]) => ({
  time,
  size: { width: 640, height: 360 },
  project: createProject(),
  videos,
})

describe('frames sent to the render worker ahead of their render', () => {
  afterEach(() => {
    gpu.log = []
    gpu.drawn = []
  })

  it('draw each render with exactly the frames staged for it, though the next render’s came in between', async () => {
    const preview = new WorkerPreview({} as OffscreenCanvas, { getFile: async () => new Blob() }, false)
    const [a1, a2] = [frame('a1'), frame('a2')]
    preview.stage(video('a', a1, { version: -1 }))
    preview.stage(video('a', a2, { version: -2 }))
    await Promise.all([
      preview.render(request(1, [ahead('a', -1), video('b', frame('b1'))])),
      preview.render(request(2, [ahead('a', -2), video('b', frame('b2'))])),
    ])
    expect(gpu.drawn).toEqual([
      { a: 'a1', b: 'b1' },
      { a: 'a2', b: 'b2' },
    ])
    expect(a1.close).toHaveBeenCalledTimes(1)
    expect(a2.close).not.toHaveBeenCalled()
    preview.dispose()
    expect(a2.close).toHaveBeenCalledTimes(1)
  })

  it('upload after the render queued before them, and before the render that draws them', async () => {
    const preview = new WorkerPreview({} as OffscreenCanvas, { getFile: async () => new Blob() }, false)
    const before = preview.render(request(1, [video('a', frame('a0')), video('b', frame('b0'))]))
    preview.stage(video('a', frame('a1'), { version: -3 }))
    preview.stage(video('b', frame('b1'), { version: -4 }))
    await Promise.all([before, preview.render(request(2, [ahead('a', -3), ahead('b', -4)]))])
    expect(gpu.log).toEqual(['render', 'stage video:a a1 -3', 'stage video:b b1 -4', 'render'])
    expect(gpu.drawn).toEqual([
      { a: 'a0', b: 'b0' },
      { a: 'a1', b: 'b1' },
    ])
    preview.dispose()
  })

  it('close one that no render takes after a few renders', async () => {
    const preview = new WorkerPreview({} as OffscreenCanvas, { getFile: async () => new Blob() }, false)
    const lost = frame('lost')
    preview.stage(video('a', lost, { version: -5 }))
    for (let i = 0; i < 8; i++) await preview.render(request(i, []))
    expect(lost.close).not.toHaveBeenCalled()
    await preview.render(request(8, []))
    expect(lost.close).toHaveBeenCalledTimes(1)
    preview.dispose()
    expect(lost.close).toHaveBeenCalledTimes(1)
  })
})
