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

/** A project that shows `count` clips, each of its own asset, the first `generated` of them generated. */
function shots(count: number, generated = 0): Project {
  const p = createProject({ name: 'shots' })
  const visual = p.tracks.find((t) => t.kind === 'visual')!
  for (let i = 0; i < count; i++) {
    const a: Asset = { ...asset(`shot${i + 1}`), origin: { type: i < generated ? 'generated' : 'import' } }
    p.assets[a.id] = a
    const clip = createVideoClip({ trackId: visual.id, assetId: a.id, start: i, duration: 1 })
    p.clips[clip.id] = clip
  }
  return p
}

async function goneMessage(p: Project, gone: string[]): Promise<string | undefined> {
  return (await mediaGone(p, media(gone)))?.message
}

const ALL_GONE =
  'The browser cleared this project’s media files, as it does when the disk is nearly full. Import them again and put them back in the timeline.'
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

  it('are gone when the browser cleared them: all of them, or which of them', async () => {
    expect(await mediaGone(project(), media(['unused']))).toBeNull()
    expect(await mediaGone(project(), media(['song', 'clip', 'grade', 'unused']))).toMatchObject({
      code: 'storage-quota',
      message: ALL_GONE,
    })
    expect(await mediaGone(project(), media(['grade']))).toMatchObject({
      code: 'storage-quota',
      message:
        'The browser cleared “grade.mp4”, 1 of the 3 media files this export uses, as it does when the disk is nearly full. Import it again and put it back in the timeline.',
    })
  })

  it('are named when only some are gone, up to three, then two and how many more', async () => {
    expect(await goneMessage(shots(6), ['shot1', 'shot2', 'shot3'])).toBe(
      'The browser cleared “shot1.mp4”, “shot2.mp4” and “shot3.mp4”, 3 of the 6 media files this export uses, as it does when the disk is nearly full. Import them again and put them back in the timeline.',
    )
    expect(await goneMessage(shots(6), ['shot2', 'shot3', 'shot4', 'shot5'])).toBe(
      'The browser cleared “shot2.mp4”, “shot3.mp4” and 2 more, 4 of the 6 media files this export uses, as it does when the disk is nearly full. Import them again and put them back in the timeline.',
    )
  })

  it('say to generate again the generated clips that are gone, and to import again a single file', async () => {
    expect(await goneMessage(shots(2, 2), ['shot1', 'shot2'])).toBe(
      'The browser cleared this project’s media files, as it does when the disk is nearly full. Generate them again and put them back in the timeline.',
    )
    expect(await goneMessage(shots(3, 1), ['shot1', 'shot2'])).toBe(
      'The browser cleared “shot1.mp4” and “shot2.mp4”, 2 of the 3 media files this export uses, as it does when the disk is nearly full. Import or generate them again and put them back in the timeline.',
    )
    expect(await goneMessage(shots(1), ['shot1'])).toBe(
      'The browser cleared this project’s media file, as it does when the disk is nearly full. Import it again and put it back in the timeline.',
    )
  })
})

describe('an export whose media are gone', () => {
  it('fails before it renders anything, saying the browser cleared them', async () => {
    const p = project()
    const job = startExport(p, [newOutput(p, 'video')], { media: media(['song', 'clip']) })
    await expect(job.promise).rejects.toMatchObject({
      code: 'storage-quota',
      message:
        'The browser cleared “clip.mp4” and “song.mp4”, 2 of the 3 media files this export uses, as it does when the disk is nearly full. Import them again and put them back in the timeline.',
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
