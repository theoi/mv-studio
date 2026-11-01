import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../src/model/types.ts'

const media = vi.hoisted(() => ({
  opened: 0,
  kept: new Map<string, Blob>(),
  /** The `ready` the app gives its timeline frame thumbnails. */
  ready: (): Promise<void> => Promise.resolve(),
}))

vi.mock('../../../src/vision/index.ts', () => ({
  coverSide: () => 320,
  coverJpeg: async () => new Blob(['made card']),
  openVideoFrames: async () => {
    media.opened++
    return {
      width: 640,
      height: 360,
      duration: 4,
      frameAt: async () => ({ close() {} }),
      dispose() {},
    }
  },
  createFrameThumbnails: (_media: unknown, options: { ready: () => Promise<void> }) => {
    media.ready = options.ready
    return {
      get: () => undefined,
      want: () => () => undefined,
      subscribe: () => () => undefined,
      dispose() {},
    }
  },
}))
vi.mock('../../../src/app/state/media.ts', () => ({ appMedia: { getFile: async () => new Blob(['video']) } }))
vi.mock('../../../src/media/mediaStore.ts', () => ({
  mediaStore: {
    readSidecar: async (asset: Asset, name: string) => media.kept.get(`${asset.id}/${name}`) ?? null,
    writeSidecar: async (asset: Asset, name: string, data: Blob) =>
      void media.kept.set(`${asset.id}/${name}`, data),
  },
}))

const { decodeThumbnailsAfter, holdThumbnailsUntil, thumbnailBlob } =
  await import('../../../src/app/state/thumbs.ts')

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const video = (id: string): Asset => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  mimeType: 'video/mp4',
  byteSize: 1,
  storageKey: `media/${id}/${id}.mp4`,
  duration: 4,
  width: 640,
  height: 360,
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
})

afterEach(() => {
  vi.useRealTimers()
  decodeThumbnailsAfter(Promise.resolve())
  media.opened = 0
  media.kept.clear()
})

describe('a project card’s thumbnail', () => {
  it('is made while thumbnails wait for the preview’s first frame, since saving the project waits for it', async () => {
    decodeThumbnailsAfter(new Promise(() => {}))
    const card = await thumbnailBlob(video('a'))
    expect(await card?.text()).toBe('made card')
    expect(media.opened).toBe(1)
    expect(media.kept.has('a/thumb1-card-320x180.jpg')).toBe(true)
  })

  it('is the kept card when there is one, without decoding the video', async () => {
    media.kept.set('b/thumb1-card-320x180.jpg', new Blob(['kept card']))
    const card = await thumbnailBlob(video('b'))
    expect(await card?.text()).toBe('kept card')
    expect(media.opened).toBe(0)
  })
})

describe('timeline frame thumbnails', () => {
  it('wait for an export trial as well as for the preview, also when another project shows meanwhile', async () => {
    let endTrial = () => {}
    holdThumbnailsUntil(new Promise<void>((resolve) => (endTrial = resolve)), 60_000)
    let show = () => {}
    decodeThumbnailsAfter(new Promise<void>((resolve) => (show = resolve)))
    let ready = false
    void media.ready().then(() => (ready = true))
    await flush()
    expect(ready).toBe(false)
    show()
    await flush()
    expect(ready).toBe(false)
    endTrial()
    await flush()
    expect(ready).toBe(true)
  })

  it('decode once a trial fails, and after maxMs when one never ends', async () => {
    holdThumbnailsUntil(Promise.reject(new Error('The render worker stopped')), 60_000)
    await expect(media.ready()).resolves.toBeUndefined()
    vi.useFakeTimers()
    holdThumbnailsUntil(new Promise(() => {}), 60_000)
    let ready = false
    void media.ready().then(() => (ready = true))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ready).toBe(true)
  })
})
