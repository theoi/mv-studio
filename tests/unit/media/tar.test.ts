import { describe, expect, it } from 'vitest'
import { readTar, writeTar } from '../../../src/media/tar.ts'

describe('tar container', () => {
  it('round-trips entries, including paths longer than 100 bytes and empty files', async () => {
    const longName = `media/${'a'.repeat(36)}/${'very_long_file_name_'.repeat(4)}.mp4`
    expect(longName.length).toBeGreaterThan(100)
    const bytes = new Uint8Array(1500).map((_, i) => i % 251)
    const tar = writeTar([
      { name: 'project.json', data: new Blob(['{"a":1}']) },
      { name: longName, data: new Blob([bytes]) },
      { name: 'empty.txt', data: new Blob([]) },
    ])
    expect(tar.size % 512).toBe(0)
    const entries = await readTar(tar)
    expect(entries.map((e) => e.name)).toEqual(['project.json', longName, 'empty.txt'])
    expect(await entries[0]!.data.text()).toBe('{"a":1}')
    expect(new Uint8Array(await entries[1]!.data.arrayBuffer())).toEqual(bytes)
    expect(entries[2]!.data.size).toBe(0)
  })

  it('rejects data that is not a tar archive', async () => {
    await expect(readTar(new Blob([new Uint8Array(1024).fill(7)]))).rejects.toThrow(
      /Not a valid project file/,
    )
  })
})
