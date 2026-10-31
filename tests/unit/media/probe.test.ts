import { describe, expect, it } from 'vitest'
import { assetTags, MAX_TAG_LENGTH } from '../../../src/media/probe.ts'

describe('assetTags', () => {
  it('keeps a trimmed title and artist', () => {
    expect(assetTags({ title: '  Neon Skyline ', artist: 'The Night Shift\n' })).toEqual({
      title: 'Neon Skyline',
      artist: 'The Night Shift',
    })
  })

  it('leaves out empty and blank tags', () => {
    expect(assetTags({ title: 'Neon Skyline', artist: '   ' })).toEqual({ title: 'Neon Skyline' })
    expect(assetTags({ title: '', artist: 'The Night Shift' })).toEqual({ artist: 'The Night Shift' })
  })

  it('gives nothing when no title or artist is left', () => {
    expect(assetTags({})).toBeUndefined()
    expect(assetTags({ title: ' ', artist: '' })).toBeUndefined()
  })

  it('cuts a title or artist longer than MAX_TAG_LENGTH characters, ending it in “…”', () => {
    const long = `${'Neon Skyline '.repeat(20)}extended mix`
    const tags = assetTags({ title: long, artist: 'The Night Shift' })
    const title = tags?.title ?? ''
    expect(title).toHaveLength(MAX_TAG_LENGTH)
    expect(title.endsWith('…')).toBe(true)
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
    expect(tags?.artist).toBe('The Night Shift')
    // Emoji count as one character and are never cut in half; a tag of exactly the limit is kept whole.
    const exact = '🌃'.repeat(MAX_TAG_LENGTH)
    expect(assetTags({ title: exact })?.title).toBe(exact)
    expect(assetTags({ artist: `${exact}🌃` })?.artist).toBe(`${'🌃'.repeat(MAX_TAG_LENGTH - 1)}…`)
  })
})
