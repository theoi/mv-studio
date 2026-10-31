import { describe, expect, it } from 'vitest'
import { audibleClips, clipGain, gainCurve, type AudibleClip } from '../../../src/engine/audio.ts'
import {
  anim,
  createAudioClip,
  createProject,
  createTrack,
  createVideoClip,
  newId,
} from '../../../src/model/factory.ts'
import type { Asset, Project, Track } from '../../../src/model/types.ts'

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
