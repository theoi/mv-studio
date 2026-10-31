import { BUILTIN_PLUGINS } from '../../../src/engine/plugins/index.ts'
import { catalogEntry } from '../../../src/engine/registry.ts'
import {
  createAudioClip,
  createProject,
  createTrack,
  type Asset,
  type AssetKind,
  type Project,
} from '../../../src/model/index.ts'
import type { PadSnapshot, Take, VjEvent, VjLayout } from '../../../src/vj/index.ts'
import { layoutPads } from '../../../src/vj/index.ts'

/** The engine's built-in plugins only, so layouts in these tests do not change as the plugin library grows. */
export const catalog = BUILTIN_PLUGINS.map(catalogEntry)

export function asset(id: string, kind: AssetKind, name: string, duration?: number, minute = 1): Asset {
  return {
    id,
    kind,
    name,
    mimeType: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'audio/mpeg',
    byteSize: 1000,
    storageKey: 'media/' + id,
    ...(duration !== undefined ? { duration } : {}),
    origin: { type: 'import' },
    createdAt: '2026-01-01T00:0' + minute + ':00.000Z',
  }
}

/** 60 s song at 120 BPM (beats every 0.5 s, bars every 2 s) on the timeline from 0, plus two clips and an image. */
export function makeProject(): Project {
  const project = createProject({ now: new Date(0), fps: 30 })
  const song = asset('song', 'audio', 'song.mp3', 60, 0)
  project.assets = {
    song,
    city: asset('city', 'video', 'Night city.mp4', 10, 1),
    singer: asset('singer', 'video', 'Singer.mp4', 4, 2),
    sunset: asset('sunset', 'image', 'Sunset.png', undefined, 3),
  }
  project.songAssetId = 'song'
  const audio = project.tracks.find((t) => t.kind === 'audio')!
  const songClip = createAudioClip({ trackId: audio.id, assetId: 'song', start: 0, duration: 60 })
  songClip.id = 'song-clip'
  project.clips[songClip.id] = songClip
  const beats = Array.from({ length: 121 }, (_, i) => i * 0.5)
  project.analysis.audio.song = {
    assetId: 'song',
    version: 'test',
    tempo: { bpm: 120, confidence: 1 },
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
  }
  return project
}

export function addVisualTrack(project: Project, name: string, index = 0) {
  const track = { ...createTrack('visual', name), id: 'track-' + name }
  project.tracks.splice(index, 0, track)
  return track
}

/** Pads of a layout by label. */
export function padsByLabel(layout: VjLayout): Record<string, PadSnapshot> {
  return Object.fromEntries(layoutPads(layout).map((p) => [p.label, p]))
}

let takeCounter = 0

export function makeTake(
  pads: PadSnapshot[],
  events: VjEvent[],
  options: { start?: number; end?: number; amounts?: Record<string, number>; id?: string } = {},
): Take {
  return {
    id: options.id ?? 'take' + ++takeCounter,
    start: options.start ?? 0,
    ...(options.end !== undefined ? { end: options.end } : {}),
    pads: Object.fromEntries(pads.map((p) => [p.id, p])),
    events,
    amounts: options.amounts ?? {},
    cursors: {},
  }
}

export const press = (t: number, pad: { id: string }, velocity = 1): VjEvent => ({
  t,
  type: 'press',
  pad: pad.id,
  velocity,
})
export const release = (t: number, pad: { id: string }): VjEvent => ({ t, type: 'release', pad: pad.id })
export const amount = (t: number, pad: { id: string }, value: number): VjEvent => ({
  t,
  type: 'amount',
  pad: pad.id,
  value,
})
