import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioBufferCache } from '../../../src/engine/audio.ts'
import { STEM_RELEASE_MS, WebAudioPlaybackClock } from '../../../src/engine/playback.ts'
import { createAudioClip, createProject } from '../../../src/model/factory.ts'
import { LAST_FRAME_LEAD } from '../../../src/model/queries.ts'
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

  it('keeps a stem that still plays while newly soloed stems decode, and releases it a minute after it stops', async () => {
    vi.useFakeTimers()
    let drumsDecoded: ((buffer: unknown) => void) | undefined
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData(data: ArrayBuffer) {
          if (new TextDecoder().decode(data) !== 'stem-drums') return Promise.resolve({ duration: 10 })
          return new Promise((resolve) => (drumsDecoded = resolve))
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    const clock = new WebAudioPlaybackClock(media)
    const cache = audioBufferCache(media)
    const song = songProject('song')
    const playing = () => clock.scheduledClips.map((c) => c.stem ?? 'song')

    clock.setProject(withStems(song, { vocals: { solo: true } }))
    await vi.waitFor(() => expect(playing()).toEqual(['vocals']))
    // The drums take longer than a minute to decode, so the vocals keep playing past their release time.
    clock.setProject(withStems(song, { drums: { solo: true } }))
    await vi.waitFor(() => expect(drumsDecoded).toBeDefined())
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(playing()).toEqual(['vocals'])
    expect(cache.loaded.has('stem-vocals')).toBe(true)

    drumsDecoded?.({ duration: 10 })
    await vi.waitFor(() => expect(playing()).toEqual(['drums']))
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(cache.loaded.has('stem-vocals')).toBe(false)
    clock.dispose()
  })

  it('leaves no release timer behind after switching to a project without those stems, or after dispose', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 10 })
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    const clock = new WebAudioPlaybackClock(media)
    const soloVocals = withStems(songProject('song'), { vocals: { solo: true } })

    clock.setProject(soloVocals)
    // Drums, bass and other are not heard.
    expect(vi.getTimerCount()).toBe(3)
    clock.setProject(songProject('other'))
    expect(vi.getTimerCount()).toBe(0)

    clock.setProject(soloVocals)
    expect(vi.getTimerCount()).toBe(3)
    clock.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never evicts what another clock on the same cache plays, even when its own project or stem flags differ', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 10 })
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    // The editor's preview, and a preview still holding a copy of the project from before the vocals were soloed.
    const editorClock = new WebAudioPlaybackClock(media)
    const otherClock = new WebAudioPlaybackClock(media)
    const cache = audioBufferCache(media)
    const song = songProject('song')
    otherClock.setProject(withStems(song))
    editorClock.setProject(withStems(song, { vocals: { solo: true } }))
    await vi.waitFor(() => expect(cache.loaded.has('stem-vocals')).toBe(true))
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(cache.loaded.has('stem-vocals')).toBe(true)
    // Once no clock hears them, the vocals go a minute later.
    editorClock.setProject(withStems(song))
    vi.advanceTimersByTime(STEM_RELEASE_MS)
    expect(cache.loaded.has('stem-vocals')).toBe(false)

    // A clock switching to another project keeps the song another clock plays.
    otherClock.setProject(songProject('other'))
    expect(cache.loaded.has('song')).toBe(true)
    // Once that clock is gone, the next change trims it.
    editorClock.dispose()
    otherClock.setProject(songProject('third'))
    expect(cache.loaded.has('song')).toBe(false)
    otherClock.dispose()
  })

  it('keeps a failure another clock reports for a stem it still wants', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData(data: ArrayBuffer) {
          return new TextDecoder().decode(data) === 'stem-bass'
            ? Promise.reject(new Error('unreadable'))
            : Promise.resolve({ duration: 10 })
        }
      },
    )
    const media = { getFile: async (asset: Asset) => new Blob([asset.id]) }
    const editorClock = new WebAudioPlaybackClock(media)
    const otherClock = new WebAudioPlaybackClock(media)
    const cache = audioBufferCache(media)
    const song = songProject('song')
    editorClock.setProject(withStems(song, { bass: { solo: true } }))
    await vi.waitFor(() => expect(cache.error('stem-bass')).toBeDefined())
    // A clock that hears no stem doesn't forget it, so the editor isn't sent to decode the bass again...
    otherClock.setProject(withStems(song))
    expect(cache.error('stem-bass')).toBeDefined()
    // ...until the editor stops wanting it.
    editorClock.setProject(withStems(song))
    expect(cache.error('stem-bass')).toBeUndefined()
    editorClock.dispose()
    otherClock.dispose()
  })

  it('plays from the top when Play is pressed on the last frame, where End leaves the playhead', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        readonly currentTime = 0
        readonly outputLatency = 0
        readonly destination = {}
        createGain() {
          return { gain: { value: 1 }, connect: () => undefined }
        }
        resume() {
          return Promise.resolve()
        }
        close() {
          return Promise.resolve()
        }
      },
    )
    const clock = new WebAudioPlaybackClock({ getFile: async () => new Blob() })
    const project = createProject()
    project.duration = 10
    clock.setProject(project)
    clock.seek(10 - LAST_FRAME_LEAD)
    await clock.play()
    expect(clock.state).toBe('playing')
    expect(clock.currentTime()).toBe(0)
    clock.pause()
    // Just before the last frame, it plays on from there.
    clock.seek(9.9)
    await clock.play()
    expect(clock.currentTime()).toBeCloseTo(9.9, 9)
    clock.dispose()
  })
})
