import { describe, expect, it, vi } from 'vitest'
import {
  audibleClips,
  AudioBufferCache,
  audioBufferCache,
  clipGain,
  gainCurve,
  type AudibleClip,
} from '../../../src/engine/audio.ts'
import {
  anim,
  createAudioClip,
  createProject,
  createTrack,
  createVideoClip,
  newId,
} from '../../../src/model/factory.ts'
import { STEM_NAMES, type Asset, type Project, type StemName, type Track } from '../../../src/model/types.ts'
import { JobError } from '../../../src/shared/jobs.ts'

function videoAsset(hasAudio: boolean): Asset {
  return {
    id: newId(),
    kind: 'video',
    name: 'v.mp4',
    mimeType: 'video/mp4',
    byteSize: 1,
    storageKey: 'media/v',
    hasAudio,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
}

function setup() {
  const project: Project = createProject()
  const visual = project.tracks.find((t) => t.kind === 'visual') as Track
  const music = project.tracks.find((t) => t.kind === 'audio') as Track
  const fx = createTrack('audio', 'FX')
  project.tracks.push(fx)
  const add = <T extends Project['clips'][string]>(clip: T): T => {
    project.clips[clip.id] = clip
    return clip
  }
  const song = add(createAudioClip({ trackId: music.id, assetId: 'song', start: 0, duration: 10 }))
  const hit = add(createAudioClip({ trackId: fx.id, assetId: 'hit', start: 2, duration: 1 }))
  const withSound = videoAsset(true)
  const silent = videoAsset(false)
  project.assets[withSound.id] = withSound
  project.assets[silent.id] = silent
  const shot = add(createVideoClip({ trackId: visual.id, assetId: withSound.id, start: 1, duration: 3 }))
  add(createVideoClip({ trackId: visual.id, assetId: silent.id, start: 4, duration: 3 }))
  return { project, music, fx, song, hit, shot }
}

const ids = (project: Project) => audibleClips(project).map((c) => c.clipId)

describe('audibleClips', () => {
  it('includes audio clips and the sound of video clips, in time order', () => {
    const { project, song, hit, shot } = setup()
    expect(ids(project)).toEqual([song.id, shot.id, hit.id])
  })

  it('honors clip mute, track mute and disabled clips', () => {
    const { project, song, hit, shot, fx } = setup()
    song.muted = true
    fx.muted = true
    expect(ids(project)).toEqual([shot.id])
    shot.enabled = false
    expect(ids(project)).toEqual([])
    void hit
  })

  it('soloing an audio track silences other tracks and video sound', () => {
    const { project, hit, fx } = setup()
    fx.solo = true
    expect(ids(project)).toEqual([hit.id])
  })
})

function stemAsset(name: string): Asset {
  return {
    id: `stem-${name}`,
    kind: 'audio',
    name: `song (${name}).ogg`,
    mimeType: 'audio/ogg',
    byteSize: 1,
    storageKey: `media/${name}`,
    origin: { type: 'stem', parentAssetId: 'song' },
    createdAt: new Date(0).toISOString(),
  }
}

/** setup() with the song's four stems separated and attached to its analysis. */
function withStems() {
  const s = setup()
  const stems: Partial<Record<StemName, string>> = {}
  for (const name of STEM_NAMES) {
    const asset = stemAsset(name)
    s.project.assets[asset.id] = asset
    stems[name] = asset.id
  }
  s.project.analysis.audio.song = { assetId: 'song', version: 'test', stems }
  return s
}

describe('audibleClips with stems', () => {
  it('replaces a clip on a track that mutes a stem by its other stems, each with its own clip id', () => {
    const { project, music, song, hit, shot } = withStems()
    music.stems = { vocals: { muted: true } }
    const clips = audibleClips(project)
    expect(clips.map((c) => [c.clipId, c.assetId, c.stem])).toEqual([
      [`${song.id}:stem:drums`, 'stem-drums', 'drums'],
      [`${song.id}:stem:bass`, 'stem-bass', 'bass'],
      [`${song.id}:stem:other`, 'stem-other', 'other'],
      [shot.id, shot.assetId, undefined],
      [hit.id, 'hit', undefined],
    ])
  })

  it('keeps the timing, volume and fades of the song clip for every stem', () => {
    const { project, music, song } = withStems()
    song.start = 1.5
    song.duration = 7
    song.sourceStart = 2.25
    song.playbackRate = 1.25
    song.volume = { value: 0.8, keyframes: [{ time: 1, value: 0.4, easing: 'linear' }] }
    song.fadeIn = 0.5
    song.fadeOut = 1.5
    const timing = (c: AudibleClip) => {
      const { start, duration, sourceStart, playbackRate, volume, fadeIn, fadeOut } = c
      return { start, duration, sourceStart, playbackRate, volume, fadeIn, fadeOut }
    }
    const plain = audibleClips(project).find((c) => c.clipId === song.id) as AudibleClip
    music.stems = { drums: { solo: true }, bass: { solo: true }, vocals: { muted: true } }
    const stems = audibleClips(project).filter((c) => c.stem)
    expect(stems.map((c) => c.stem)).toEqual(['drums', 'bass'])
    for (const clip of stems) expect(timing(clip)).toEqual(timing(plain))
    music.stems = { drums: { solo: true } }
    expect(audibleClips(project).map(timing)).toEqual([timing(plain)])
  })

  it('plays exactly the same clips as a project without stems when no stem is muted or soloed', () => {
    const { project, music } = withStems()
    const bare = structuredClone(project)
    delete bare.analysis.audio.song
    expect(audibleClips(project)).toEqual(audibleClips(bare))
    music.stems = { vocals: { muted: false, solo: false } }
    expect(audibleClips(project)).toEqual(audibleClips(bare))
  })

  it('ignores stem flags on a song without separated stems, including stem solo', () => {
    const { project, music } = setup()
    const before = audibleClips(project)
    music.stems = { vocals: { muted: true }, bass: { solo: true } }
    expect(audibleClips(project)).toEqual(before)
  })

  it('a soloed stem silences the other audio tracks and the sound of video clips', () => {
    const { project, music, song } = withStems()
    music.stems = { bass: { solo: true } }
    expect(ids(project)).toEqual([`${song.id}:stem:bass`])
  })

  it('combines track solo and stem solo', () => {
    const { project, music, fx, song, hit } = withStems()
    // A soloed track without stem solo plays all its stems that are not muted.
    music.solo = true
    music.stems = { drums: { muted: true } }
    expect(ids(project)).toEqual([`${song.id}:stem:vocals`, `${song.id}:stem:bass`, `${song.id}:stem:other`])
    // Another soloed track is heard alongside the stem solo.
    music.solo = false
    music.stems = { vocals: { solo: true } }
    fx.solo = true
    expect(ids(project)).toEqual([`${song.id}:stem:vocals`, hit.id])
    // Track solo plus stem solo on the same track plays only the soloed stems.
    music.solo = true
    fx.solo = false
    expect(ids(project)).toEqual([`${song.id}:stem:vocals`])
  })

  it('mute wins over solo on the same stem', () => {
    const { project, music, song } = withStems()
    music.stems = { vocals: { solo: true, muted: true }, bass: { solo: true } }
    expect(ids(project)).toEqual([`${song.id}:stem:bass`])
    music.stems = { vocals: { solo: true, muted: true } }
    expect(ids(project)).toEqual([])
  })

  it('skips stems whose asset is no longer in the project', () => {
    const { project, music, song, shot, hit } = withStems()
    delete project.assets['stem-vocals']
    music.stems = { drums: { muted: true } }
    expect(ids(project)).toEqual([`${song.id}:stem:bass`, `${song.id}:stem:other`, shot.id, hit.id])
  })

  it('keeps clip mute, track mute and disabled clips over stem flags', () => {
    const { project, music, song, shot, hit } = withStems()
    music.stems = { vocals: { muted: true } }
    song.muted = true
    expect(ids(project)).toEqual([shot.id, hit.id])
    song.muted = false
    music.muted = true
    expect(ids(project)).toEqual([shot.id, hit.id])
  })

  it('plays the plain mix with stems: false', () => {
    const { project, music } = withStems()
    const plain = audibleClips(project)
    music.stems = { bass: { solo: true }, vocals: { muted: true } }
    expect(audibleClips(project, { stems: false })).toEqual(plain)
    expect(audibleClips(project)).not.toEqual(plain)
  })
})
describe('AudioBufferCache', () => {
  const asset = (id: string, origin: Asset['origin']['type'] = 'import'): Asset => ({
    ...stemAsset(id),
    id,
    origin: { type: origin },
  })
  const buffer = (id: string) => ({ id }) as unknown as AudioBuffer
  const media = { getFile: async (a: Asset) => new Blob([a.id]) }
  const clip = (assetId: string): AudibleClip => ({
    clipId: assetId,
    assetId,
    start: 0,
    duration: 1,
    sourceStart: 0,
    playbackRate: 1,
    volume: anim(1),
    fadeIn: 0,
    fadeOut: 0,
  })
  const project = (...assets: Asset[]): Project => {
    const p = createProject()
    for (const a of assets) p.assets[a.id] = a
    return p
  }

  it('resolves load() with a snapshot that eviction does not change', async () => {
    const a = asset('a', 'stem')
    const b = asset('b')
    const cache = new AudioBufferCache(media, {
      decode: async (data) => buffer(await new Blob([data]).text()),
    })
    const buffers = await cache.load(project(a, b), [clip('a'), clip('b')])
    cache.evict((x) => x.origin.type === 'stem')
    expect([...buffers.keys()].sort()).toEqual(['a', 'b'])
    expect([...cache.loaded.keys()]).toEqual(['b'])
  })

  it('does not keep a buffer evicted while it was decoding', async () => {
    let finish: (b: AudioBuffer) => void = () => undefined
    const cache = new AudioBufferCache(media, { decode: () => new Promise((resolve) => (finish = resolve)) })
    const a = asset('a', 'stem')
    const pending = cache.load(project(a), [clip('a')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    cache.evict(() => true)
    const decoded = buffer('a')
    finish(decoded)
    expect((await pending).get('a')).toBe(decoded)
    expect(cache.loaded.size).toBe(0)
  })

  it('records why a decode failed: out-of-memory for a RangeError, decode otherwise', async () => {
    const errors: Record<string, Error> = {
      big: new RangeError('Array buffer allocation failed'),
      bad: new DOMException('Unable to decode audio data', 'EncodingError'),
    }
    const cache = new AudioBufferCache(media, {
      decode: async (data) => {
        throw errors[await new Blob([data]).text()]
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const buffers = await cache.load(project(asset('big'), asset('bad')), [clip('big'), clip('bad')])
    warn.mockRestore()
    expect(buffers.size).toBe(0)
    expect(cache.error('big')).toBeInstanceOf(JobError)
    expect(cache.error('big')?.code).toBe('out-of-memory')
    expect(cache.error('bad')?.code).toBe('decode')
  })

  it('remembers a failure until asked to retry, and forgets it on eviction', async () => {
    let attempts = 0
    let fail = true
    const cache = new AudioBufferCache(media, {
      decode: async () => {
        attempts++
        if (fail) throw new RangeError('no memory')
        return buffer('a')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const a = asset('a', 'stem')
    expect(await cache.get(a)).toBeNull()
    expect(await cache.get(a)).toBeNull()
    expect(attempts).toBe(1)
    fail = false
    expect(await cache.get(a, { retry: true })).not.toBeNull()
    expect(cache.error('a')).toBeUndefined()
    expect(attempts).toBe(2)
    fail = true
    cache.evict(() => true)
    expect(await cache.get(a)).toBeNull()
    expect(attempts).toBe(3)
    warn.mockRestore()
  })

  it('shares one cache per media source', () => {
    const other = { getFile: media.getFile }
    expect(audioBufferCache(media)).toBe(audioBufferCache(media))
    expect(audioBufferCache(other)).not.toBe(audioBufferCache(media))
  })
})
describe('clip gain', () => {
  const clip: AudibleClip = {
    clipId: 'c',
    assetId: 'a',
    start: 0,
    duration: 10,
    sourceStart: 0,
    playbackRate: 1,
    volume: anim(0.5),
    fadeIn: 1,
    fadeOut: 2,
  }

  it('multiplies volume by linear fade-in and fade-out ramps', () => {
    expect(clipGain(clip, 0.5)).toBeCloseTo(0.25)
    expect(clipGain(clip, 5)).toBeCloseTo(0.5)
    expect(clipGain(clip, 9)).toBeCloseTo(0.25)
  })

  it('follows volume keyframes', () => {
    const keyed: AudibleClip = {
      ...clip,
      fadeIn: 0,
      fadeOut: 0,
      volume: {
        value: 1,
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 4, value: 1, easing: 'linear' },
        ],
      },
    }
    expect(clipGain(keyed, 1)).toBeCloseTo(0.25)
  })

  it('is a constant without fades or keyframes, otherwise a curve sampled from the start offset to the clip end', () => {
    expect(gainCurve({ ...clip, fadeIn: 0, fadeOut: 0 }, 3)).toBe(0.5)
    const curve = gainCurve(clip, 4)
    expect(curve).toBeInstanceOf(Float32Array)
    const samples = curve as Float32Array
    expect(samples.length).toBe(601)
    expect(samples[0]).toBeCloseTo(0.5)
    expect(samples[samples.length - 1]).toBeCloseTo(0)
  })
})
