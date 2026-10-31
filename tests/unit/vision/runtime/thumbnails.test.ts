import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../../src/model/types.ts'
import {
  createFrameThumbnails,
  type FrameThumbnailOptions,
} from '../../../../src/vision/runtime/thumbnails.ts'

function asset(id: string, kind: Asset['kind'] = 'video', extra: Partial<Asset> = {}): Asset {
  return {
    id,
    kind,
    name: `${id}.mp4`,
    mimeType: kind === 'image' ? 'image/jpeg' : 'video/mp4',
    byteSize: 1000,
    storageKey: `media/${id}`,
    duration: 10,
    width: 640,
    height: 360,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
    ...extra,
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Fake decoders that record what is asked of them. With `manual`, each frame waits for `finishNext()`. */
function fakeVideos(config: { manual?: boolean; unsupported?: string[] } & FrameThumbnailOptions = {}) {
  const decoded: string[] = []
  const maxSides: (number | undefined)[] = []
  const openAttempts: string[] = []
  const disposed: string[] = []
  const waiting: (() => void)[] = []
  const thumbs = createFrameThumbnails(
    { getFile: async (a) => new Blob([a.id]) },
    {
      ...config,
      open: async (a) => {
        openAttempts.push(a.id)
        if (config.unsupported?.includes(a.id)) throw new Error('unsupported codec')
        return {
          mediaId: a.id,
          width: a.width ?? 0,
          height: a.height ?? 0,
          duration: a.duration ?? 0,
          frameRate: 30,
          frameAt: (t, o) =>
            new Promise<ImageBitmap>((resolve) => {
              decoded.push(`${a.id}@${t}`)
              maxSides.push(o?.maxSide)
              const bitmap = { label: `${a.id}@${t}`, close() {} } as unknown as ImageBitmap
              if (config.manual) waiting.push(() => resolve(bitmap))
              else resolve(bitmap)
            }),
          dispose: () => disposed.push(a.id),
        }
      },
      draw: (frame, w, h) => `${(frame as unknown as { label: string }).label} ${w}x${h}`,
    },
  )
  const finishNext = async () => {
    waiting.shift()?.()
    await flush()
  }
  return { thumbs, decoded, maxSides, openAttempts, disposed, finishNext }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('frame thumbnails', () => {
  it('makes one frame per rounded source time, shared by clips with nearby in-points', async () => {
    const { thumbs, decoded, maxSides } = fakeVideos()
    const a = asset('a')
    const changes = vi.fn()
    thumbs.subscribe(changes)
    thumbs.want(a, 1.1)
    thumbs.want(a, 0.9)
    thumbs.want(a, 3.3)
    await flush()
    expect(decoded).toEqual(['a@1', 'a@3.5'])
    expect(thumbs.get(a, 1.2)).toBe('a@1 160x90')
    expect(thumbs.get(a, 3.6)).toBe('a@3.5 160x90')
    expect(thumbs.get(a, 6)).toBeUndefined()
    expect(changes).toHaveBeenCalledTimes(2)
    // Decoded just large enough to cover 160×90.
    expect(maxSides).toEqual([160, 160])
  })

  it('decodes portrait video tall enough to cover a landscape thumbnail, and clamps times to the video', async () => {
    const { thumbs, decoded, maxSides } = fakeVideos()
    const tall = asset('tall', 'video', { width: 360, height: 640, duration: 4 })
    thumbs.want(tall, 9)
    await flush()
    expect(decoded).toEqual(['tall@4'])
    expect(maxSides).toEqual([285])
  })

  it('decodes the newest request first and skips frames released before their turn', async () => {
    const { thumbs, decoded, finishNext } = fakeVideos({ manual: true })
    const a = asset('a')
    thumbs.want(a, 1)
    await flush()
    thumbs.want(a, 2)
    const release3 = thumbs.want(a, 3)
    thumbs.want(a, 4)
    release3()
    await finishNext()
    await finishNext()
    await finishNext()
    expect(decoded).toEqual(['a@1', 'a@4', 'a@2'])
    expect(thumbs.get(a, 3)).toBeUndefined()
  })

  it('keeps at most maxOpen videos open, closing the least recently used idle one', async () => {
    const { thumbs, openAttempts, disposed, finishNext } = fakeVideos({ manual: true, maxOpen: 2 })
    thumbs.want(asset('a'), 1)
    thumbs.want(asset('b'), 1)
    thumbs.want(asset('c'), 1)
    await flush()
    expect(openAttempts).toEqual(['a', 'b'])
    await finishNext()
    expect(disposed).toEqual(['a'])
    expect(openAttempts).toEqual(['a', 'b', 'c'])
  })

  it('finishes the open video’s frames before switching videos, so interleaved clips do not reopen it', async () => {
    const { thumbs, decoded, openAttempts, finishNext } = fakeVideos({ manual: true, maxOpen: 1 })
    const a = asset('a')
    const b = asset('b')
    thumbs.want(a, 1)
    thumbs.want(b, 1)
    thumbs.want(a, 2)
    thumbs.want(b, 2)
    await flush()
    for (let i = 0; i < 4; i++) await finishNext()
    expect(decoded).toEqual(['a@1', 'a@2', 'b@2', 'b@1'])
    expect(openAttempts).toEqual(['a', 'b'])
  })

  it('closes a video after idleMs without work', async () => {
    vi.useFakeTimers()
    const { thumbs, disposed } = fakeVideos({ idleMs: 5000 })
    thumbs.want(asset('a'), 1)
    await flush()
    await vi.advanceTimersByTimeAsync(4999)
    expect(disposed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(disposed).toEqual(['a'])
  })

  it('gives a video that does not open no thumbnails, without retrying it, and keeps decoding others', async () => {
    const { thumbs, openAttempts } = fakeVideos({ unsupported: ['bad'] })
    const bad = asset('bad')
    thumbs.want(bad, 1)
    await flush()
    thumbs.want(bad, 2)
    thumbs.want(asset('good'), 1)
    await flush()
    expect(openAttempts).toEqual(['bad', 'good'])
    expect(thumbs.get(bad, 1)).toBeUndefined()
    expect(thumbs.get(asset('good'), 1)).toBe('good@1 160x90')
  })

  it('keeps shown frames when the cache is full and drops hidden ones, least recently requested first', async () => {
    const { thumbs } = fakeVideos({ maxEntries: 2 })
    const a = asset('a')
    const release1 = thumbs.want(a, 1)
    const release2 = thumbs.want(a, 2)
    thumbs.want(a, 3)
    await flush()
    expect([1, 2, 3].map((t) => thumbs.get(a, t) !== undefined)).toEqual([true, true, true])
    release2()
    release1()
    expect([1, 2, 3].map((t) => thumbs.get(a, t) !== undefined)).toEqual([true, false, true])
  })

  it('leaves images and audio to the asset thumbnail', async () => {
    const { thumbs, openAttempts } = fakeVideos()
    thumbs.want(asset('still', 'image'), 1)
    thumbs.want(asset('song', 'audio'), 1)
    await flush()
    expect(openAttempts).toEqual([])
  })
})
