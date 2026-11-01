import { describe, expect, it } from 'vitest'
import { removeUnusedFolders, type MediaFolder } from '../../../src/media/mediaStore.ts'

type Entry = MediaFolder extends { values(): AsyncIterable<infer E> } ? E : never

const NOW = Date.UTC(2026, 10, 1)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const file = (name: string, size: number, age: number): Entry => ({
  kind: 'file',
  name,
  getFile: async () => ({ size, lastModified: NOW - age }),
})

class FakeFolder implements MediaFolder {
  readonly kind = 'directory'
  readonly name: string
  entries: Entry[]
  private readonly locked: Set<string>
  constructor(name: string, entries: Entry[], locked = new Set<string>()) {
    this.name = name
    this.entries = entries
    this.locked = locked
  }
  async *values() {
    yield* this.entries
  }
  async removeEntry(name: string) {
    if (this.locked.has(name)) throw new DOMException('The file is open', 'NoModificationAllowedError')
    this.entries = this.entries.filter((e) => e.name !== name)
  }
}

const names = (media: FakeFolder) => media.entries.map((e) => e.name)
const sweep = (media: FakeFolder, inUse: string[] = []) =>
  removeUnusedFolders(media, new Set(inUse), { minAgeMs: DAY, now: NOW })

describe('removeUnusedFolders', () => {
  it('deletes an old folder no project uses and keeps the ones in use', async () => {
    const media = new FakeFolder('media', [
      new FakeFolder('a', [file('song.wav', 100, 2 * DAY), file('extra.bin', 50, 3 * DAY)]),
      new FakeFolder('b', [file('clip.mp4', 70, 9 * DAY)]),
    ])
    expect(await sweep(media, ['media/b'])).toEqual({ folders: 1, bytes: 150 })
    expect(names(media)).toEqual(['b'])
  })

  it('keeps a folder no project uses while any of its files is newer than the age', async () => {
    const media = new FakeFolder('media', [
      new FakeFolder('a', [file('old.bin', 10, 5 * DAY), file('new.bin', 10, HOUR)]),
      new FakeFolder('b', [file('song.wav', 10, DAY - HOUR)]),
    ])
    expect(await sweep(media)).toEqual({ folders: 0, bytes: 0 })
    expect(names(media)).toEqual(['a', 'b'])
  })

  it('leaves what it cannot date or the store never makes: empty folders, folders in folders, loose files', async () => {
    const media = new FakeFolder('media', [
      new FakeFolder('empty', []),
      new FakeFolder('nested', [
        file('a.bin', 10, 5 * DAY),
        new FakeFolder('inner', [file('b.bin', 10, 5 * DAY)]),
      ]),
      file('loose.bin', 10, 5 * DAY),
    ])
    expect(await sweep(media)).toEqual({ folders: 0, bytes: 0 })
    expect(names(media)).toEqual(['empty', 'nested', 'loose.bin'])
  })

  it('counts only the folders it could delete, and still deletes the rest', async () => {
    const media = new FakeFolder(
      'media',
      [
        new FakeFolder('open', [file('a.bin', 10, 2 * DAY)]),
        new FakeFolder('free', [file('b.bin', 20, 2 * DAY)]),
      ],
      new Set(['open']),
    )
    expect(await sweep(media)).toEqual({ folders: 1, bytes: 20 })
    expect(names(media)).toEqual(['open'])
  })
})
