import { describe, expect, it } from 'vitest'
import {
  lostMedia,
  storageClearedMessage,
  writeAgain,
  type StorageLoss,
} from '../../../src/app/state/storageCleared.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { SavedHistory } from '../../../src/model/editor.ts'
import type { Asset, Project } from '../../../src/model/types.ts'

function asset(
  id: string,
  origin: Asset['origin'],
  kind: Asset['kind'] = 'video',
  storageKey = `media/${id}/f`,
): Asset {
  return {
    id,
    kind,
    name: id,
    mimeType: 'video/mp4',
    byteSize: 10,
    storageKey,
    origin,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

const CAUSE = 'The browser cleared MV Studio’s storage, as it does when the disk is nearly full.'
const none = { files: 0, clips: 0, images: 0, others: 0 }

describe('the note after the browser cleared the site’s storage', () => {
  it.each<[Partial<StorageLoss> & Pick<StorageLoss, 'project'>, string]>([
    [
      { project: 'saved', files: 2, others: 1 },
      `${CAUSE} This project’s edits are kept, but its 2 media files are gone. Your other project in this browser was cleared too. Free some disk space, then import the files again and put them back in the timeline.`,
    ],
    [
      { project: 'saved', files: 1, clips: 2, images: 1, others: 3 },
      `${CAUSE} This project’s edits are kept, but its 1 media file, 2 generated clips and 1 generated image are gone. Your 3 other projects in this browser were cleared too. Free some disk space, then import the file and generate the clips and image again, and put them back in the timeline.`,
    ],
    [
      { project: 'saved', clips: 1 },
      `${CAUSE} This project’s edits are kept, but its 1 generated clip is gone. Free some disk space, then generate the clip again and put it back in the timeline.`,
    ],
    [
      { project: 'saved', others: 1 },
      `${CAUSE} This project is kept. Your other project in this browser was cleared too. Free some disk space before you go on.`,
    ],
    [
      { project: 'not-saved', files: 3 },
      `${CAUSE} This project is still open but couldn’t be saved again, and its 3 media files are gone. Free some disk space, then import the files again and put them back in the timeline.`,
    ],
    [
      { project: 'not-saved' },
      `${CAUSE} This project is still open but couldn’t be saved again. Free some disk space before you go on.`,
    ],
    [
      { project: 'not-kept', others: 2 },
      `${CAUSE} Your 2 projects in this browser were cleared. Free some disk space before you go on.`,
    ],
    [
      { project: 'not-kept', images: 1, others: 1 },
      `${CAUSE} This project’s 1 generated image is gone. Your project in this browser was cleared. Free some disk space, then generate the image again and put it back in the timeline.`,
    ],
  ])('says what was kept, what was lost and what to do: %o', (loss, message) => {
    expect(storageClearedMessage({ ...none, ...loss })).toBe(message)
  })

  it('is not shown when nothing was lost', () => {
    expect(storageClearedMessage({ ...none, project: 'saved' })).toBeNull()
    expect(storageClearedMessage({ ...none, project: 'not-kept' })).toBeNull()
  })
})

describe('the media the browser cleared from a project', () => {
  it('counts imported files and recordings, and generated clips and images, but not media made from them', async () => {
    const project = createProject({ name: 'cleared' })
    const assets = [
      asset('song', { type: 'import' }, 'audio'),
      asset('clip', { type: 'import' }),
      asset('kept', { type: 'import' }),
      asset('take', { type: 'recording' }),
      asset('shot', { type: 'generated', provider: 'fal-ai/kling' }),
      asset('still', { type: 'generated', provider: 'fal-ai/flux' }, 'image'),
      asset('vocals', { type: 'stem', parentAssetId: 'song' }, 'audio'),
      asset('mask', { type: 'derived', parentAssetId: 'clip' }, 'image'),
      // Sample media is made, not stored.
      asset('city', { type: 'import' }, 'video', 'mock:city'),
    ]
    for (const a of assets) project.assets[a.id] = a
    const asked: string[] = []
    const has = async (a: Asset) => {
      asked.push(a.id)
      if (a.id === 'take') throw new DOMException('gone', 'NotFoundError')
      return a.id === 'kept'
    }
    expect(await lostMedia(project, has)).toEqual({ files: 3, clips: 1, images: 1 })
    expect(asked.sort()).toEqual(['clip', 'kept', 'shot', 'song', 'still', 'take'])
  })
})

describe('writing the open project again after the browser cleared it', () => {
  const closed = () => new DOMException('The connection was closed.', 'AbortError')
  const history = (updatedAt: string): SavedHistory => ({ updatedAt, undo: [], redo: [] })
  const noWait = async () => {}

  it('writes the project open at each try with its own history, so an edit saved meanwhile is not written over', async () => {
    const first = createProject({ name: 'Before' })
    const edited = { ...first, name: 'Edited meanwhile' }
    let open = { project: first, history: history('1') }
    const tries: [Project, SavedHistory | undefined][] = []
    const write = async (project: Project, h?: SavedHistory) => {
      tries.push([project, h])
      if (tries.length > 1) return
      // The edit lands, and autosave writes it, while the database reopens.
      open = { project: edited, history: history('2') }
      throw closed()
    }
    expect(await writeAgain(first.id, () => open, write, noWait)).toBe(true)
    expect(tries.map(([p, h]) => [p.name, h?.updatedAt])).toEqual([
      ['Before', '1'],
      ['Edited meanwhile', '2'],
    ])
  })

  it('stops once another project is open', async () => {
    const first = createProject({ name: 'First' })
    let open = { project: first, history: history('1') }
    const tries: string[] = []
    const write = async (project: Project) => {
      tries.push(project.name)
      open = { project: createProject({ name: 'Second' }), history: history('2') }
      throw closed()
    }
    expect(await writeAgain(first.id, () => open, write, noWait)).toBe(false)
    expect(tries).toEqual(['First'])
  })

  it('tries for about 3 s, then gives up with the last error', async () => {
    const project = createProject({ name: 'Stuck' })
    const waits: number[] = []
    let tries = 0
    const write = async () => {
      tries++
      throw closed()
    }
    await expect(
      writeAgain(
        project.id,
        () => ({ project }),
        write,
        async (ms) => void waits.push(ms),
      ),
    ).rejects.toThrow('The connection was closed.')
    expect(waits).toEqual([50, 100, 200, 400, 800, 1600])
    expect(tries).toBe(7)
  })
})
