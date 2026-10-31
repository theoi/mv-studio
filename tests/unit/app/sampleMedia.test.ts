import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../src/model/types.ts'

/** Encodes started, the finalize calls waiting to be let through, and the scenes drawn (with whether they're kept). */
const encoder = vi.hoisted(() => ({
  started: 0,
  finish: [] as (() => void)[],
  scenes: [] as string[],
}))

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
  sceneLayers: (scene: string, _w: number, _h: number, keep = true) => {
    encoder.scenes.push(keep ? scene : `${scene} (not kept)`)
    return { bg: {}, fg: null }
  },
}))

const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) }

function asset(kind: Asset['kind'], storageKey: string): Asset {
  return { id: `${kind}:${storageKey}`, kind, name: storageKey, storageKey, duration: 4 } as Asset
}

/** A project's assets, by id. */
const assets = (...list: Asset[]): Record<string, Asset> => Object.fromEntries(list.map((a) => [a.id, a]))

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const city = asset('video', 'mock:city')
const rain = asset('video', 'mock:rain')
const ocean = asset('video', 'mock:ocean')
let idle: (() => void)[] = []

/** A fresh copy of the module, so each test starts with nothing made or queued. */
async function load() {
  vi.resetModules()
  return import('../../../src/app/mock/sampleMedia.ts')
}

describe('preparing the sample videos', () => {
  beforeEach(() => {
    idle = []
    encoder.started = 0
    encoder.finish = []
    encoder.scenes = []
    vi.stubGlobal('requestIdleCallback', (run: () => void) => idle.push(run))
    vi.stubGlobal('document', { createElement: () => canvas })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes them one at a time in idle moments, and their first use takes the prepared file', async () => {
    const { prepareSampleVideos, sampleFile } = await load()
    const project = assets(city, asset('image', 'mock:city'), asset('video', 'imported-file'), rain)
    prepareSampleVideos(project)
    expect(idle).toHaveLength(1)
    expect(encoder.scenes).toEqual([])

    // The scene is drawn in one idle moment, without keeping it, and its encoding starts in the next.
    idle.shift()?.()
    expect(encoder.scenes).toEqual(['city (not kept)'])
    expect(encoder.started).toBe(0)
    expect(idle).toHaveLength(1)
    idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(1)
    // The next video waits for this one to finish.
    expect(idle).toHaveLength(0)
    encoder.finish.shift()?.()
    await settle()
    idle.shift()?.()
    idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(2)
    encoder.finish.shift()?.()
    await settle()
    idle.shift()?.()
    // The image and the imported video were left alone.
    expect(idle).toHaveLength(0)
    expect(encoder.scenes).toEqual(['city (not kept)', 'rain (not kept)'])

    const file = await sampleFile(city)
    expect(file.size).toBe(8)
    expect(encoder.started).toBe(2)
    // Edits that leave the assets alone don't look at them again, and new ones find these made.
    prepareSampleVideos(project)
    prepareSampleVideos({ ...project })
    expect(idle).toHaveLength(0)
  })

  it('stops when another project opens or the editor closes: the video underway finishes, no more', async () => {
    const { prepareSampleVideos } = await load()
    prepareSampleVideos(assets(city, rain, ocean))
    idle.shift()?.()
    idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(1)
    prepareSampleVideos(assets(asset('video', 'imported-file')))
    encoder.finish.shift()?.()
    await settle()
    while (idle.length) idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(1)
    expect(encoder.scenes).toEqual(['city (not kept)'])

    // Back on the sample, the rest is made; closing the editor stops that too.
    prepareSampleVideos(assets(city, rain, ocean))
    idle.shift()?.()
    expect(encoder.scenes).toEqual(['city (not kept)', 'rain (not kept)'])
    prepareSampleVideos(null)
    idle.shift()?.()
    await settle()
    encoder.finish.shift()?.()
    await settle()
    while (idle.length) idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(2)
    expect(encoder.scenes).toEqual(['city (not kept)', 'rain (not kept)'])
  })

  it('skips a video made on demand before its turn, without drawing its scene', async () => {
    const { prepareSampleVideos, sampleFile } = await load()
    prepareSampleVideos(assets(city, rain))
    // The first jump reaches rain before the page is idle.
    const onDemand = sampleFile(rain)
    await settle()
    expect(encoder.started).toBe(1)
    encoder.finish.shift()?.()
    await onDemand
    expect(encoder.scenes).toEqual(['rain'])

    idle.shift()?.()
    idle.shift()?.()
    await settle()
    encoder.finish.shift()?.()
    await settle()
    while (idle.length) idle.shift()?.()
    await settle()
    expect(encoder.started).toBe(2)
    expect(encoder.scenes).toEqual(['rain', 'city (not kept)'])
  })
})
