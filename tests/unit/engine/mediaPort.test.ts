import { afterEach, describe, expect, it } from 'vitest'
import { portMedia, serveMedia } from '../../../src/engine/previewWorker.ts'
import type { Asset } from '../../../src/model/types.ts'
import { JobError } from '../../../src/shared/jobs.ts'

const clip: Asset = {
  id: 'clip',
  kind: 'video',
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  byteSize: 1,
  storageKey: 'media/clip/clip.mp4',
  duration: 4,
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
}

const channels: MessageChannel[] = []

afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close()
    c.port2.close()
  }
})

/** The worker end of a media port served by `getFile` on the other end. */
function bridged(getFile: (asset: Asset) => Promise<Blob>) {
  const channel = new MessageChannel()
  channels.push(channel)
  serveMedia(channel.port1, { getFile })
  return portMedia(channel.port2)
}

describe('the media port', () => {
  it.each([
    new JobError('invalid-input', 'The media file for "clip" is missing from browser storage'),
    new JobError('network', 'The connection dropped'),
  ])("rejects in the worker with the page's error code, message and retryability ($code)", async (error) => {
    const media = bridged(() => Promise.reject(error))
    const received = await media.getFile(clip).catch((e: unknown) => e)
    expect(received).toBeInstanceOf(JobError)
    expect(received).toMatchObject({ code: error.code, message: error.message, retryable: error.retryable })
  })
})
