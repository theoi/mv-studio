/*
 * Builds the demo project for the design preview as a real schema-v1 Project, so every screen reads and edits the
 * same shapes the engine and analysis modules produce. Media bytes do not exist: assets point at procedural scenes
 * through storageKey 'mock:<scene>' and are drawn by ./art.ts.
 */
import {
  anim,
  createAudioClip,
  createImageClip,
  createProject,
  createTextClip,
  createVideoClip,
  defaultTransform,
  type Asset,
  type AudioAnalysis,
  type AudioModulation,
  type GeneratorClip,
  type LyricsDoc,
  type Project,
  type Track,
} from '../../model/index.ts'
import { createLookClip, lookRegistry } from '../../plugins/looks.ts'
import { songFeatures } from './arrangement.ts'
import type { SceneId } from './art.ts'
import { media } from './media.ts'
import { beatInterval, energy, energyRate, lyrics, sections, song } from './song.ts'

const CREATED = '2026-10-31T00:00:00.000Z'
export const SONG_ASSET_ID = 'a-song'
export const TRACK_IDS = {
  lyrics: 't-lyrics',
  look: 't-look',
  overlay: 't-overlay',
  video: 't-video',
  song: 't-song',
} as const

export function sceneOf(asset: Asset | undefined): SceneId | undefined {
  return asset?.storageKey.startsWith('mock:') ? (asset.storageKey.slice(5) as SceneId) : undefined
}

export const MASK_PREFIX = 'mock-mask:'

/** Frame rate of the videos made for the sample's scenes, which are still: a low one is enough and encodes fast. */
export const SAMPLE_VIDEO_FPS = 2

/** Storage key of the subject mask generated for a sample scene. */
export function maskStorageKey(scene: SceneId): string {
  return `${MASK_PREFIX}${scene}`
}

function asset(
  id: string,
  kind: Asset['kind'],
  name: string,
  scene: string,
  duration?: number,
  generated = false,
): Asset {
  return {
    id,
    kind,
    name,
    mimeType: kind === 'audio' ? 'audio/wav' : kind === 'image' ? 'image/jpeg' : 'video/mp4',
    byteSize: Math.round((duration ?? 1) * 1_200_000),
    storageKey: `mock:${scene}`,
    duration,
    frameRate: kind === 'video' ? SAMPLE_VIDEO_FPS : undefined,
    width: kind === 'audio' ? undefined : 1920,
    height: kind === 'audio' ? undefined : 1080,
    hasAudio: kind === 'video' ? false : undefined,
    origin: generated
      ? { type: 'generated', provider: 'fal-ai', prompt: 'aurora over a neon city' }
      : { type: 'import' },
    createdAt: CREATED,
  }
}

function track(id: string, kind: Track['kind'], name: string): Track {
  return { id, kind, name, muted: false, solo: false, locked: false, hidden: false }
}

function generator(
  id: string,
  start: number,
  duration: number,
  generatorId: string,
  name: string,
  params: GeneratorClip['params'],
): GeneratorClip {
  return {
    id,
    trackId: TRACK_IDS.overlay,
    name,
    start,
    duration,
    enabled: true,
    transform: defaultTransform(),
    opacity: anim(1),
    blendMode: 'screen',
    effects: [],
    type: 'generator',
    generatorId,
    params,
  }
}

const spectrumParams = (): GeneratorClip['params'] => ({
  bars: anim(48),
  color: { value: '#ffffffd0' },
  color2: { value: '#c9c2ffd0' },
  height: anim(0.14),
  gap: anim(0.45),
})

/** A small push on every beat, so choruses pulse with the music. */
const beatPulse = (): AudioModulation[] => [
  { source: { kind: 'beat' }, amount: 0.025, mode: 'add', smoothing: 0.3 },
]

const LYRIC_STYLE = {
  fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
  fontSize: 72,
  fontWeight: 750,
  shadow: { color: 'rgba(0,0,0,0.55)', blur: 28, offsetX: 0, offsetY: 2 },
}

const cutPlan: Record<string, { every: number; scenes: SceneId[] }> = {
  's-intro': { every: 8, scenes: ['city', 'rain'] },
  's-v1': { every: 4, scenes: ['portrait', 'city', 'ocean', 'sunset', 'portrait', 'tunnel', 'city', 'rain'] },
  's-pre': { every: 2, scenes: ['neon', 'portrait', 'tunnel', 'crowd'] },
  's-c1': {
    every: 2,
    scenes: ['crowd', 'portrait', 'neon', 'dancer', 'crowd', 'tunnel', 'portrait', 'aurora'],
  },
  's-v2': { every: 4, scenes: ['rain', 'portrait', 'sunset', 'city', 'ocean', 'portrait', 'tunnel', 'city'] },
  's-c2': {
    every: 2,
    scenes: ['dancer', 'crowd', 'portrait', 'neon', 'tunnel', 'crowd', 'dancer', 'portrait'],
  },
  's-bridge': { every: 8, scenes: ['aurora', 'sunset', 'ocean'] },
  's-c3': { every: 2, scenes: ['crowd', 'portrait', 'neon', 'dancer', 'tunnel', 'portrait'] },
  's-outro': { every: 8, scenes: ['city'] },
}

/** The clip used for the "clip selected" preview: a close-up where the subject fills the frame. */
export const FEATURED_CLIP_ID = 'c-s-c1-1'

export function buildDemoProject(): Project {
  const base = createProject({ name: song.title, now: new Date(CREATED) })
  const assets: Record<string, Asset> = {
    [SONG_ASSET_ID]: asset(SONG_ASSET_ID, 'audio', song.file, 'song', song.duration),
  }
  for (const m of media) {
    assets[m.id] = asset(
      m.id,
      m.type === 'image' ? 'image' : 'video',
      m.name,
      m.scene,
      m.duration,
      m.type === 'generated',
    )
  }
  const byScene = Object.fromEntries(media.map((m) => [m.scene, m]))

  const clips: Project['clips'] = {}
  const add = (c: Project['clips'][string]) => (clips[c.id] = c)

  for (const s of sections) {
    const plan = cutPlan[s.id]
    if (!plan) continue
    let i = 0
    for (let t = s.start; t < s.end - 0.01; t += plan.every) {
      const scene = plan.scenes[i % plan.scenes.length] as SceneId
      const m = byScene[scene]
      if (!m) continue
      const duration = Math.min(s.end, t + plan.every) - t
      const id = `c-${s.id}-${i}`
      const common = { trackId: TRACK_IDS.video, assetId: m.id, start: t, duration }
      const clip =
        m.type === 'image' ? { ...createImageClip(common), id } : { ...createVideoClip(common), id }
      if (s.id.startsWith('s-c')) {
        clip.transform.scaleX.modulation = beatPulse()
        clip.transform.scaleY.modulation = beatPulse()
      }
      add(clip)
      i++
    }
  }

  add({
    ...createTextClip({
      trackId: TRACK_IDS.overlay,
      text: 'NEON SKYLINE',
      start: 1,
      duration: 8,
      style: {
        fontFamily: LYRIC_STYLE.fontFamily,
        fontWeight: 800,
        letterSpacing: 0.22,
        textTransform: 'uppercase',
        shadow: LYRIC_STYLE.shadow,
      },
    }),
    id: 'o-title',
    name: 'Title',
    animation: { presetId: 'fade-up', params: {} },
  })
  add(generator('o-spec1', 64, 32, 'visualizer.spectrum', 'Spectrum bars', spectrumParams()))
  add(generator('o-spec2', 128, 32, 'visualizer.spectrum', 'Spectrum bars', spectrumParams()))
  add(
    generator('o-part', 160, 24, 'visualizer.particles', 'Particles', {
      color: { value: '#ffffff' },
      density: anim(0.4),
      size: anim(5),
      speed: anim(0.35),
      reactivity: anim(1.2),
    }),
  )

  for (const line of lyrics) {
    const clip = createTextClip({
      trackId: TRACK_IDS.lyrics,
      text: line.text,
      start: line.start,
      duration: line.end - line.start,
      style: LYRIC_STYLE,
    })
    clip.transform.y = anim(0.75)
    add({
      ...clip,
      id: `t-${line.id}`,
      lyricLineId: line.id,
      animation: { presetId: 'fade-up', params: {} },
      karaoke: { highlightColor: '#ffd27a', mode: 'word' },
    })
  }

  const neon = lookRegistry.get('neon')
  if (neon) {
    const look = createLookClip(neon, { trackId: TRACK_IDS.look, start: 0, duration: song.duration })
    add({ ...look, id: 'c-look', opacity: anim(0.7) })
  }

  add({
    ...createAudioClip({
      trackId: TRACK_IDS.song,
      assetId: SONG_ASSET_ID,
      start: 0,
      duration: song.duration,
    }),
    id: 'a-song-clip',
  })

  const beats: number[] = []
  const downbeats: number[] = []
  for (let i = 0; i * beatInterval < song.duration; i++) {
    beats.push(+(i * beatInterval).toFixed(3))
    if (i % 4 === 0) downbeats.push(+(i * beatInterval).toFixed(3))
  }
  const chorusGroup = 1
  const analysis: AudioAnalysis = {
    assetId: SONG_ASSET_ID,
    version: 'mock-1',
    tempo: { bpm: song.bpm, confidence: 0.94 },
    beats,
    downbeats,
    sections: sections.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      label: s.label,
      repeatGroup: s.kind === 'chorus' ? chorusGroup : undefined,
    })),
    energy: { rate: energyRate, values: Array.from(energy, (v) => +v.toFixed(3)) },
    features: songFeatures(),
  }

  const lyricsDoc: LyricsDoc = {
    audioAssetId: SONG_ASSET_ID,
    source: 'pasted',
    lines: lyrics.map((l) => ({
      id: l.id,
      text: l.text,
      start: l.start,
      end: l.end,
      words: l.words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })),
    })),
  }

  // Each sample keeps the fresh id createProject gave it: a kept sample is a project of its own, which a new sample
  // must never be saved over.
  return {
    ...base,
    songAssetId: SONG_ASSET_ID,
    assets,
    tracks: [
      track(TRACK_IDS.lyrics, 'visual', 'Lyrics'),
      track(TRACK_IDS.look, 'visual', 'Look'),
      track(TRACK_IDS.overlay, 'visual', 'Overlay'),
      track(TRACK_IDS.video, 'visual', 'Video'),
      track(TRACK_IDS.song, 'audio', 'Song'),
    ],
    clips,
    analysis: { audio: { [SONG_ASSET_ID]: analysis }, visual: {} },
    lyrics: lyricsDoc,
    duration: song.duration,
  }
}

/** The sample song ("Use a sample song" on the setup screen): its asset, its analysis and its timed lyrics. */
export function sampleSong(): { title: string; asset: Asset; analysis: AudioAnalysis; lyrics: LyricsDoc } {
  const demo = buildDemoProject()
  const asset = demo.assets[SONG_ASSET_ID]
  const analysis = demo.analysis.audio[SONG_ASSET_ID]
  if (!asset || !analysis || !demo.lyrics) throw new Error('The sample project has no song')
  return { title: song.title, asset, analysis, lyrics: demo.lyrics }
}
