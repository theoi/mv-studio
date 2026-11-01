import { describe, expect, it, vi } from 'vitest'
import type * as EngineExport from '../../../src/engine/export.ts'
import { exportProject } from '../../../src/engine/export.ts'
import {
  exportedAssets,
  exportFailure,
  mediaGone,
  newOutput,
  startExport,
} from '../../../src/export/outputs.ts'
import { createAudioClip, createProject, createVideoClip } from '../../../src/model/factory.ts'
import type { Asset, Project } from '../../../src/model/types.ts'
import { JobError } from '../../../src/shared/jobs.ts'

vi.mock('../../../src/engine/export.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EngineExport>()),
  exportProject: vi.fn(async () => {
    throw new Error('rendered')
  }),
}))

function asset(id: string, kind: Asset['kind'] = 'video'): Asset {
  return {
    id,
    kind,
    name: `${id}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 10,
    storageKey: `media/${id}/${id}.mp4`,
    origin: { type: 'import' },
    createdAt: '2026-01-01T00:00:00.000Z',
    duration: 8,
  }
}

/** A project that plays the song and shows the clip graded by an image, with another clip in its library only. */
function project(): Project {
  const p = createProject({ name: 'cleared' })
  for (const a of [asset('song', 'audio'), asset('clip'), asset('grade', 'image'), asset('unused')])
    p.assets[a.id] = a
  const visual = p.tracks.find((t) => t.kind === 'visual')!
  const audio = p.tracks.find((t) => t.kind === 'audio')!
  const clip = createVideoClip({ trackId: visual.id, assetId: 'clip', start: 0, duration: 4 })
  clip.effects = [{ id: 'fx', effectId: 'lut', enabled: true, params: { lut: { value: 'grade' } } }]
  const song = createAudioClip({ trackId: audio.id, assetId: 'song', start: 0, duration: 8 })
  p.clips[clip.id] = clip
  p.clips[song.id] = song
  return p
}

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

const ALL_GONE = 'The browser cleared this project’s media, as it does when the disk is nearly full.'
const notFound = new DOMException(
  'A requested file or directory could not be found at the time an operation was processed.',
  'NotFoundError',
)

describe('the media an export uses', () => {
  it('are the assets its clips name, in their media and their effects, not the rest of the library', () => {
    expect(
      exportedAssets(project())
        .map((a) => a.id)
        .sort(),
    ).toEqual(['clip', 'grade', 'song'])
  })

  it('are gone when the browser cleared them: all of them, or how many of them', async () => {
    expect(await mediaGone(project(), media(['unused']))).toBeNull()
    expect(await mediaGone(project(), media(['song', 'clip', 'grade', 'unused']))).toMatchObject({
      code: 'storage-quota',
      message: ALL_GONE,
    })
    expect(await mediaGone(project(), media(['grade']))).toMatchObject({
      code: 'storage-quota',
      message:
        'The browser cleared 1 of the 3 media files this export uses, as it does when the disk is nearly full.',
    })
  })
})

describe('an export whose media are gone', () => {
  it('fails before it renders anything, saying the browser cleared them', async () => {
    const p = project()
    const job = startExport(p, [newOutput(p, 'video')], { media: media(['song', 'clip']) })
    await expect(job.promise).rejects.toMatchObject({
      code: 'storage-quota',
      message:
        'The browser cleared 2 of the 3 media files this export uses, as it does when the disk is nearly full.',
    })
    expect(exportProject).not.toHaveBeenCalled()
  })
})

describe('an export that failed', () => {
  it('says the browser cleared the media it uses when they are no longer stored', async () => {
    const error = await exportFailure(notFound, project(), media(['song', 'clip', 'grade']))
    expect(error).toBeInstanceOf(JobError)
    expect(error).toMatchObject({ code: 'storage-quota', message: ALL_GONE, cause: notFound })
  })

  it('keeps its own error while the media it uses are all stored', async () => {
    const store = media(['unused'])
    expect(await exportFailure(notFound, project(), store)).toBe(notFound)
    expect(store.asked.sort()).toEqual(['clip', 'grade', 'song'])
  })

  it('keeps a cancel as it is, without looking at the media', async () => {
    const cancelled = new JobError('cancelled', 'Export cancelled')
    const store = media(['clip', 'song'])
    expect(await exportFailure(cancelled, project(), store)).toBe(cancelled)
    expect(store.asked).toEqual([])
  })
})
