import { describe, expect, it } from 'vitest'
import { createAudioSampler } from '../../../src/engine/audioFeatures.ts'
import { createAudioClip, createProject, newId } from '../../../src/model/factory.ts'
import type { Asset, Project } from '../../../src/model/types.ts'

function songProject(clipStart: number, sourceStart: number): Project {
  const project = createProject()
  const audioTrack = project.tracks.find((t) => t.kind === 'audio')!
  const asset: Asset = {
    id: newId(),
    kind: 'audio',
    name: 'song.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 1,
    storageKey: 'media/x/song.mp3',
    duration: 10,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
  const clip = createAudioClip({
    trackId: audioTrack.id,
    assetId: asset.id,
    start: clipStart,
    duration: 8,
    sourceStart,
  })
  // loudness ramps 0..1 over the 10 s song at 10 values/s; band 1 is constant 0.5
  const n = 101
  return {
    ...project,
    songAssetId: asset.id,
    assets: { [asset.id]: asset },
    clips: { [clip.id]: clip },
    analysis: {
      audio: {
        [asset.id]: {
          assetId: asset.id,
          version: 'test',
          beats: [1, 2, 3],
          features: {
            rate: 10,
            loudness: Array.from({ length: n }, (_, i) => i / (n - 1)),
            bands: Array.from({ length: n }, () => [0, 0.5]),
            bandEdgesHz: [0, 200, 20000],
            onsets: [],
          },
        },
      },
      visual: {},
    },
  }
}

describe('audio sampler', () => {
  it('maps timeline time through the song clip position and trim', () => {
    // Clip placed at 2 s on the timeline, starting 3 s into the song: timeline 4 s is song 5 s.
    const sampler = createAudioSampler(songProject(2, 3))
    expect(sampler.sample({ kind: 'loudness' }, 4)).toBeCloseTo(0.5)
    expect(sampler.sample({ kind: 'band', band: 1 }, 4)).toBeCloseTo(0.5)
    // Before the clip starts and after it ends the song is silent.
    expect(sampler.sample({ kind: 'loudness' }, 1)).toBe(0)
    expect(sampler.sample({ kind: 'loudness' }, 10.5)).toBe(0)
  })

  it('produces beat pulses that peak on the beat and decay', () => {
    const sampler = createAudioSampler(songProject(0, 0))
    expect(sampler.sample({ kind: 'beat' }, 0.5)).toBe(0)
    expect(sampler.sample({ kind: 'beat' }, 2)).toBeCloseTo(1)
    const later = sampler.sample({ kind: 'beat' }, 2.2)
    expect(later).toBeGreaterThan(0)
    expect(later).toBeLessThan(0.5)
  })

  it('smooths using only past values, deterministically', () => {
    const sampler = createAudioSampler(songProject(0, 0))
    const raw = sampler.sample({ kind: 'loudness' }, 5, 0)
    const smooth = sampler.sample({ kind: 'loudness' }, 5, 1)
    expect(smooth).toBeLessThan(raw)
    expect(smooth).toBeGreaterThan(raw - 0.05)
    expect(sampler.sample({ kind: 'loudness' }, 5, 1)).toBe(smooth)
  })

  it('returns silence for a muted song track', () => {
    const project = songProject(0, 0)
    project.tracks = project.tracks.map((t) => (t.kind === 'audio' ? { ...t, muted: true } : t))
    expect(createAudioSampler(project).sample({ kind: 'loudness' }, 5)).toBe(0)
  })
})
