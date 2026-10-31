import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../src/model/types.ts'

/** Encodes started, the finalize calls waiting to be let through, and the scenes drawn. */
const encoder = vi.hoisted(() => ({ started: 0, finish: [] as (() => void)[], scenes: [] as string[] }))

vi.mock('mediabunny', () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }
  class Output {
    private readonly target: BufferTarget
    constructor(options: { target: BufferTarget }) {
      this.target = options.target
    }
    addVideoTrack(): void {}
    async start(): Promise<void> {
      encoder.started++
    }
    async finalize(): Promise<void> {
      await new Promise<void>((resolve) => encoder.finish.push(resolve))
      this.target.buffer = new ArrayBuffer(8)
    }
  }
  class CanvasSource {
    async add(): Promise<void> {}
    close(): void {}
  }
  return {
    BufferTarget,
    Output,
    CanvasSource,
    WebMOutputFormat: class {},
    Mp4OutputFormat: class {},
    canEncodeVideo: async () => true,
  }
})
vi.mock('../../../src/app/mock/art.ts', () => ({
  sceneLayers: (scene: string) => {
    encoder.scenes.push(scene)
    return { bg: {}, fg: null }
  },
}))

const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) }

function asset(kind: Asset['kind'], storageKey: string): Asset {
  return { id: storageKey, kind, name: storageKey, storageKey, duration: 4 } as Asset
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('preparing the sample videos', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes them one at a time in idle moments, and their first use takes the prepared file', async () => {
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (run: () => void) => idle.push(run))
    vi.stubGlobal('document', { createElement: () => canvas })
    const { prepareSampleVideos, sampleFile } = await import('../../../src/app/mock/sampleMedia.ts')
    const city = asset('video', 'mock:city')
    const rain = asset('video', 'mock:rain')
    prepareSampleVideos([city, asset('image', 'mock:city'), asset('video', 'imported-file'), rain])
    expect(idle).toHaveLength(1)
    expect(encoder.scenes).toEqual([])

    // The scene is drawn in one idle moment, its encoding starts in the next.
    idle.shift()?.()
    expect(encoder.scenes).toEqual(['city'])
    expect(encoder.started).toBe(0)
    expect(idle).toHaveLength(1)
    idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(1)
    // The next video waits for this one to finish.
    expect(idle).toHaveLength(0)
    encoder.finish.shift()?.()
    await settle()
    expect(idle).toHaveLength(1)
    idle.shift()?.()
    idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(2)
    encoder.finish.shift()?.()
    await settle()
    // The image and the imported video were left alone.
    expect(idle).toHaveLength(0)

    const file = await sampleFile(city)
    expect(file.size).toBe(8)
    expect(encoder.started).toBe(2)
    prepareSampleVideos([city, rain])
    expect(idle).toHaveLength(0)
  })
})
