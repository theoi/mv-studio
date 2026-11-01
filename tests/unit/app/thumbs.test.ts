import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../src/model/types.ts'

const media = vi.hoisted(() => ({
  opened: 0,
  kept: new Map<string, Blob>(),
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
  createFrameThumbnails: () => ({
    get: () => undefined,
    want: () => () => undefined,
    subscribe: () => () => undefined,
    dispose() {},
  }),
}))
vi.mock('../../../src/app/state/media.ts', () => ({ appMedia: { getFile: async () => new Blob(['video']) } }))
vi.mock('../../../src/media/mediaStore.ts', () => ({
  mediaStore: {
    readSidecar: async (asset: Asset, name: string) => media.kept.get(`${asset.id}/${name}`) ?? null,
    writeSidecar: async (asset: Asset, name: string, data: Blob) =>
      void media.kept.set(`${asset.id}/${name}`, data),
  },
}))

const { decodeThumbnailsAfter, thumbnailBlob } = await import('../../../src/app/state/thumbs.ts')

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
