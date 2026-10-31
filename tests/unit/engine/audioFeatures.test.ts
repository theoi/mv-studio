import { describe, expect, it } from 'vitest'
import { clipSampler, createAudioSampler, gridPosition } from '../../../src/engine/audioFeatures.ts'
import type { AudioFrame } from '../../../src/engine/types.ts'
import { createAudioClip, createProject, createSolidClip, newId } from '../../../src/model/factory.ts'
import type { Asset, Clip, GeneratorClip, Project } from '../../../src/model/types.ts'

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

describe('audio frame motion and stems', () => {
  it('places frames on the beat grid, interpolating between uneven beats and extrapolating outside them', () => {
    const sampler = createAudioSampler(songProject(0, 0))
    // beats at 1, 2, 3 s
    expect(sampler.frame(1.5)).toMatchObject({ beatIndex: 0, beatPhase: 0.5 })
    expect(sampler.frame(2.25)).toMatchObject({ beatIndex: 1 })
    expect(sampler.frame(2.25).beatPhase).toBeCloseTo(0.25)
    expect(sampler.frame(4.5)).toMatchObject({ beatIndex: 3, beatPhase: 0.5 })
    expect(sampler.frame(0.5)).toMatchObject({ beatIndex: -1, beatPhase: 0.5 })
    expect(gridPosition([0, 1, 3], 2)).toBeCloseTo(1.5)
    expect(gridPosition([1], 2)).toBeNull()
  })

  it('derives bars from downbeats, or four beats per bar from the first downbeat', () => {
    const project = songProject(0, 0)
    const analysis = Object.values(project.analysis.audio)[0]!
    analysis.beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
    analysis.downbeats = [0.5]
    const bars = createAudioSampler(project)
    // First bar starts on the downbeat at 0.5 s (beat 1); 2.5 s is beat 5, one bar later.
    expect(bars.frame(2.5)).toMatchObject({ barIndex: 1, barPhase: 0 })
    expect(bars.frame(1.5).barPhase).toBeCloseTo(0.5)
    analysis.downbeats = [0, 2, 4]
    expect(createAudioSampler(project).frame(3)).toMatchObject({ barIndex: 1, barPhase: 0.5 })
  })

  it('pulses the downbeat on every fourth beat until bars are found, on the bars barIndex counts', () => {
    const project = songProject(0, 0)
    const analysis = Object.values(project.analysis.audio)[0]!
    analysis.beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
    delete analysis.downbeats
    const fromFirstBeat = createAudioSampler(project)
    expect(fromFirstBeat.frame(2)).toMatchObject({ downbeat: 1, barIndex: 1, barPhase: 0 })
    expect(fromFirstBeat.frame(2.2).downbeat).toBeCloseTo(Math.exp(-1))
    expect(fromFirstBeat.frame(1.9).downbeat).toBeLessThan(0.01)
    expect(fromFirstBeat.sample({ kind: 'downbeat' }, 4)).toBeCloseTo(1)
    analysis.downbeats = [0.5]
    const fromDownbeat = createAudioSampler(project)
    expect(fromDownbeat.frame(2.5)).toMatchObject({ downbeat: 1, barIndex: 1, barPhase: 0 })
    expect(fromDownbeat.frame(2.1).downbeat).toBeLessThan(0.01)
  })

  it('follows the tempo, or 120 BPM, without beats', () => {
    const project = songProject(0, 0)
    const analysis = Object.values(project.analysis.audio)[0]!
    delete analysis.beats
    expect(createAudioSampler(project).frame(1.25)).toMatchObject({ beatIndex: 2, beatPhase: 0.5 })
    analysis.tempo = { bpm: 60, confidence: 1 }
    expect(createAudioSampler(project).frame(1.25)).toMatchObject({ beatIndex: 1, barIndex: 0 })
    expect(createAudioSampler(project).frame(1.25).beatPhase).toBeCloseTo(0.25)
  })

  it('integrates loudness into flow, statelessly and in song time', () => {
    // Loudness ramps 0..1 over 10 s, so its integral to t is t^2 / 20.
    const sampler = createAudioSampler(songProject(0, 0))
    expect(sampler.frame(4).flow).toBeCloseTo(0.8, 1)
    expect(sampler.frame(8).flow).toBeCloseTo(3.2, 1)
    expect(sampler.frame(8).flow).toBeGreaterThan(sampler.frame(7.9).flow)
    // Scrubbing back and forth gives the same values as playing through.
    const first = sampler.frame(5).flow
    sampler.frame(9)
    expect(sampler.frame(5).flow).toBe(first)
    expect(createAudioSampler(songProject(0, 0)).frame(5).flow).toBe(first)
    // Clip at 2 s starting 3 s into the song: timeline 4 s is song 5 s.
    expect(createAudioSampler(songProject(2, 3)).frame(4).flow).toBeCloseTo(first, 6)
  })

  it('keeps motion continuous where the song is not playing and without any analysis', () => {
    const shifted = createAudioSampler(songProject(2, 0))
    // Before the song clip starts the grid extrapolates backwards from the song's beats.
    expect(shifted.frame(1.5)).toMatchObject({ loudness: 0, beatIndex: -2, beatPhase: 0.5 })
    const bare = createAudioSampler(createProject())
    expect(bare.frame(3)).toMatchObject({ loudness: 0, beatIndex: 6, beatPhase: 0, flow: 1.5 })
  })

  it('reports stem loudness and onsets only for separated stems', () => {
    const project = songProject(0, 0)
    const analysis = Object.values(project.analysis.audio)[0]!
    expect(createAudioSampler(project).frame(2).stems).toEqual({})
    analysis.stemFeatures = {
      drums: { rate: 10, loudness: Array(101).fill(0.8), bands: [], bandEdgesHz: [], onsets: [2] },
    }
    const stems = createAudioSampler(project).frame(2).stems
    expect(Object.keys(stems)).toEqual(['drums'])
    expect(stems.drums?.loudness).toBeCloseTo(0.8)
    expect(stems.drums?.onset).toBeCloseTo(1)
    expect(createAudioSampler(project).frame(2.3).stems.drums?.onset).toBeLessThan(0.1)
  })
})

describe('stem audio sources', () => {
  function withDrums(): Project {
    const project = songProject(0, 0)
    const analysis = Object.values(project.analysis.audio)[0]!
    analysis.stemFeatures = {
      drums: {
        rate: 10,
        loudness: Array(101).fill(0.8),
        bands: Array.from({ length: 101 }, () => [0.9, 0.1]),
        bandEdgesHz: [0, 200, 20000],
        onsets: [2],
      },
    }
    return project
  }

  it('takes loudness, bands, onsets and flow from the stem, and keeps the song’s beat grid', () => {
    const mix = createAudioSampler(withDrums())
    const drums = mix.stem('drums').frame(2)
    const song = mix.frame(2)
    expect(drums.loudness).toBeCloseTo(0.8)
    expect(drums.bands[0]).toBeCloseTo(0.9)
    expect(drums.bands[1]).toBeCloseTo(0.1)
    expect(drums.onset).toBeCloseTo(1)
    expect(drums.flow).toBeCloseTo(1.6)
    expect(song.loudness).toBeCloseTo(0.2)
    expect(song.bands[0]).toBeCloseTo(0)
    expect(song.flow).toBeCloseTo(0.2, 1)
    const grid = (f: AudioFrame) => [f.beat, f.downbeat, f.beatIndex, f.beatPhase, f.barIndex, f.barPhase]
    expect(grid(drums)).toEqual(grid(song))
    expect(drums.stems).toEqual(song.stems)
  })

  it('feeds sources without a stem from the stem; explicit stems and beats are unchanged', () => {
    const mix = createAudioSampler(withDrums())
    const drums = mix.stem('drums')
    expect(drums.sample({ kind: 'loudness' }, 2)).toBeCloseTo(0.8)
    expect(drums.sample({ kind: 'band', band: 0 }, 2)).toBeCloseTo(0.9)
    expect(drums.sample({ kind: 'onset' }, 2)).toBeCloseTo(1)
    expect(drums.sample({ kind: 'loudness', stem: 'vocals' }, 2)).toBe(0)
    expect(drums.sample({ kind: 'beat' }, 2)).toBe(mix.sample({ kind: 'beat' }, 2))
    expect(mix.sample({ kind: 'loudness' }, 2)).toBeCloseTo(0.2)
  })

  it('uses the full mix for a stem that has not been separated', () => {
    const mix = createAudioSampler(withDrums())
    expect(mix.stem('vocals').frame(2)).toEqual(mix.frame(2))
    expect(mix.stem('vocals').sample({ kind: 'loudness' }, 2)).toBeCloseTo(0.2)
  })

  it('gives a generator clip with an audio source its stem, and other clips the mix', () => {
    const project = withDrums()
    const visual = project.tracks.find((t) => t.kind === 'visual')!
    const { color: _color, ...base } = createSolidClip({
      trackId: visual.id,
      color: '#000',
      start: 0,
      duration: 4,
    })
    const generator: GeneratorClip = {
      ...base,
      type: 'generator',
      generatorId: 'visualizer.spectrum',
      params: {},
    }
    const mix = createAudioSampler(project)
    const loudness = (clip: Clip) => clipSampler(mix, clip).sample({ kind: 'loudness' }, 2)
    expect(loudness({ ...generator, audio: { stem: 'drums' } })).toBeCloseTo(0.8)
    expect(loudness(generator)).toBeCloseTo(0.2)
    expect(loudness({ ...base, color: { value: '#000' }, type: 'solid' })).toBeCloseTo(0.2)
  })
})
