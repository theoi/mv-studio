import { describe, expect, it } from 'vitest'
import { exportFailure } from '../../../src/export/outputs.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Asset } from '../../../src/model/types.ts'
import { JobError } from '../../../src/shared/jobs.ts'

function asset(id: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 10,
    storageKey: `media/${id}/${id}.mp4`,
    origin: { type: 'import' },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

const project = createProject({ name: 'cleared' })
project.assets.song = asset('song')
project.assets.clip = asset('clip')

/** Media whose `gone` assets are no longer stored, with the assets asked for. */
function media(gone: string[]) {
  const asked: string[] = []
  return {
    asked,
    getFile: async (a: Asset) => {
      asked.push(a.id)
      if (gone.includes(a.id))
        throw new JobError('invalid-input', `The media file for “${a.name}” is missing`)
      return new Blob(['x'])
    },
  }
}

const notFound = new DOMException(
  'A requested file or directory could not be found at the time an operation was processed.',
  'NotFoundError',
)

describe('an export that failed', () => {
  it('says the browser cleared the project’s media when they are no longer stored', async () => {
    const error = await exportFailure(notFound, project, media(['clip']))
    expect(error).toBeInstanceOf(JobError)
    expect(error).toMatchObject({
      code: 'storage-quota',
      message: 'The browser cleared this project’s media, as it does when the disk is nearly full.',
      cause: notFound,
    })
  })

  it('keeps its own error while the media are all stored', async () => {
    const store = media([])
    expect(await exportFailure(notFound, project, store)).toBe(notFound)
    expect(store.asked.sort()).toEqual(['clip', 'song'])
  })

  it('keeps a cancel as it is, without looking at the media', async () => {
    const cancelled = new JobError('cancelled', 'Export cancelled')
    const store = media(['clip', 'song'])
    expect(await exportFailure(cancelled, project, store)).toBe(cancelled)
    expect(store.asked).toEqual([])
  })
})
