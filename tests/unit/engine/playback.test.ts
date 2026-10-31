import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioBufferCache } from '../../../src/engine/audio.ts'
import { WebAudioPlaybackClock } from '../../../src/engine/playback.ts'
import { createAudioClip, createProject } from '../../../src/model/factory.ts'
import type { Asset, Project, Track } from '../../../src/model/types.ts'

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

describe('WebAudioPlaybackClock', () => {
  afterEach(() => vi.unstubAllGlobals())

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
})
