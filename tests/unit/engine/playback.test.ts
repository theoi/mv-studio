import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioBufferCache } from '../../../src/engine/audio.ts'
import { STEM_RELEASE_MS, WebAudioPlaybackClock } from '../../../src/engine/playback.ts'
import { createAudioClip, createProject } from '../../../src/model/factory.ts'
import {
  STEM_NAMES,
  type Asset,
  type Project,
  type StemName,
  type Track,
  type TrackStems,
} from '../../../src/model/types.ts'

function songProject(assetId: string): Project {
  const project = createProject()
  const music = project.tracks.find((t) => t.kind === 'audio') as Track
  project.assets[assetId] = {
    id: assetId,
    kind: 'audio',
    name: `${assetId}.wav`,
    mimeType: 'audio/wav',
    byteSize: 1,
    storageKey: `media/${assetId}`,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
  const clip = createAudioClip({ trackId: music.id, assetId, start: 0, duration: 10 })
  project.clips[clip.id] = clip
  return project
}

/** The song project with the song's four stems separated, and the music track's stem flags set to `flags`. */
function withStems(project: Project, flags?: TrackStems): Project {
  const next = structuredClone(project)
  const stems: Partial<Record<StemName, string>> = {}
  for (const name of STEM_NAMES) {
    const id = `stem-${name}`
    next.assets[id] = {
      ...(next.assets.song as Asset),
      id,
      name: `song (${name}).ogg`,
      storageKey: `media/${id}`,
      origin: { type: 'stem', parentAssetId: 'song' },
    }
    stems[name] = id
  }
  next.analysis.audio.song = { assetId: 'song', version: 'test', stems }
  const music = next.tracks.find((t) => t.kind === 'audio') as Track
  if (flags) music.stems = flags
  return next
}

describe('WebAudioPlaybackClock', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shares decoded audio with the other clocks on its media source, so disposing one keeps theirs', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 10 })
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    const editorClock = new WebAudioPlaybackClock(media)
    const stillsClock = new WebAudioPlaybackClock(media)
    const project = songProject('song')
    editorClock.setProject(project)
    stillsClock.setProject(project)
    const cache = audioBufferCache(media)
    await vi.waitFor(() => expect(cache.loaded.has('song')).toBe(true))

    stillsClock.dispose()
    expect(cache.loaded.has('song')).toBe(true)

    // Opening another project drops the audio it cannot play.
    editorClock.setProject(songProject('other'))
    expect(cache.loaded.has('song')).toBe(false)
    await vi.waitFor(() => expect(cache.loaded.has('other')).toBe(true))
    editorClock.dispose()
  })

  it('keeps a stem nobody hears decoded for a minute, then releases it; a stem that failed goes once no stem is heard', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData(data: ArrayBuffer) {
          const id = new TextDecoder().decode(data)
          return id === 'stem-bass'
            ? Promise.reject(new Error('unreadable'))
            : Promise.resolve({ duration: 10 })
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    const clock = new WebAudioPlaybackClock(media)
    const cache = audioBufferCache(media)
    const song = songProject('song')
    const solo = (name: StemName) => withStems(song, { [name]: { solo: true } })

    clock.setProject(solo('vocals'))
    await vi.waitFor(() => expect(cache.loaded.has('stem-vocals')).toBe(true))
    // Soloing the drums instead keeps the vocals decoded for a while, so switching back is instant...
    clock.setProject(solo('drums'))
    await vi.waitFor(() => expect(cache.loaded.has('stem-drums')).toBe(true))
    vi.advanceTimersByTime(STEM_RELEASE_MS - 1000)
    expect(cache.loaded.has('stem-vocals')).toBe(true)
    // ...and hearing them again stops their release; the drums go a minute after they were last heard.
    clock.setProject(solo('vocals'))
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(cache.loaded.has('stem-vocals')).toBe(true)
    expect(cache.loaded.has('stem-drums')).toBe(false)

    // Without stem flags the stems are not dropped at once either, and the song stays.
    clock.setProject(withStems(song))
    expect(cache.loaded.has('stem-vocals')).toBe(true)
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(cache.loaded.has('stem-vocals')).toBe(false)
    expect(cache.loaded.has('song')).toBe(true)

    // A stem that could not be decoded is forgotten as soon as no stem is heard, so the next solo tries it again.
    clock.setProject(solo('bass'))
    await vi.waitFor(() => expect(cache.error('stem-bass')).toBeDefined())
    clock.setProject(withStems(song))
    expect(cache.error('stem-bass')).toBeUndefined()
    clock.dispose()
  })
})
