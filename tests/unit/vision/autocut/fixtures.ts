import { createFootageMatcher } from '../../../../src/vision/matching/matcher.ts'
import { buildVisualAnalysis } from '../../../../src/vision/analysisData.ts'
import type { EmbeddingModel, OnnxBackend } from '../../../../src/vision/backends.ts'
import type { ClipVisionIndex } from '../../../../src/vision/types.ts'
import { createProject } from '../../../../src/model/factory.ts'
import type { Asset, AudioAnalysis, LyricLine, Project } from '../../../../src/model/types.ts'

/** 100 BPM: a beat every 0.6 s, a bar every 2.4 s; 24 bars. */
export const BEAT = 0.6
export const SONG_LENGTH = 57.6
export const BEATS = Array.from({ length: 96 }, (_, i) => Math.round(i * BEAT * 1000) / 1000)
export const DOWNBEATS = BEATS.filter((_, i) => i % 4 === 0)
export const SECTIONS = [
  { id: 'intro', label: 'intro', start: 0, end: 9.6, energy: 0.1 },
  { id: 'verse', label: 'verse', start: 9.6, end: 28.8, energy: 0.5 },
  { id: 'chorus', label: 'chorus', start: 28.8, end: 48, energy: 0.95 },
  { id: 'outro', label: 'outro', start: 48, end: 57.6, energy: 0.2 },
]

function line(id: string, text: string, start: number, end: number): LyricLine {
  return { id, text, start, end, words: [] }
}

export const LYRICS = [
  line('l1', 'neon city lights at night', 9.6, 14.4),
  line('l2', 'waves on the ocean shore', 14.4, 19.2),
  line('l3', 'everybody dance with the crowd', 28.8, 33.6),
]

export const MODEL: EmbeddingModel = 'clipB32'
const DIM = 4
/** Each test clip shows one thing; text embeddings point at the thing a line mentions. */
export const TOPICS: Record<string, number> = { city: 0, ocean: 1, crowd: 2 }

function asset(id: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset {
  return {
    id,
    kind,
    name: `${id}.${kind === 'image' ? 'jpg' : kind === 'audio' ? 'mp3' : 'mp4'}`,
    mimeType: kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
    byteSize: 1000,
    storageKey: `media/${id}`,
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
    ...extra,
  }
}

function unit(topic: number | null): number[] {
  if (topic === null) return [0.5, 0.5, 0.5, 0.5]
  return Array.from({ length: DIM }, (_, i) => (i === topic ? 1 : 0))
}

export function clipIndex(
  assetId: string,
  duration: number,
  topic: number | null,
  activity: number,
): ClipVisionIndex {
  const times = Array.from({ length: Math.floor(duration) }, (_, i) => i)
  const energy = Array.from({ length: Math.floor(duration * 4) }, () => activity)
  return {
    version: 1,
    mediaId: assetId,
    duration,
    model: MODEL,
    dim: DIM,
    times,
    embeddings: new Float32Array(times.flatMap(() => unit(topic))),
    hubness: times.map(() => 0),
    motion: {
      fps: 4,
      energy,
      camera: energy.map(() => 0),
      cuts: [],
      meanEnergy: activity,
      p90Energy: activity,
      meanCamera: 0,
    },
  }
}

export interface ClipSpec {
  id: string
  duration?: number
  topic?: keyof typeof TOPICS | null
  activity?: number
  image?: boolean
  indexed?: boolean
}

export const CLIPS: ClipSpec[] = [
  { id: 'city', duration: 20, topic: 'city', activity: 3 },
  { id: 'ocean', duration: 25, topic: 'ocean', activity: 1 },
  { id: 'crowd', duration: 15, topic: 'crowd', activity: 12 },
  { id: 'misc', duration: 30, topic: null, activity: 5 },
]

export function songAnalysis(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    assetId: 'song',
    version: 'test',
    tempo: { bpm: 100, confidence: 0.9 },
    beats: BEATS,
    downbeats: DOWNBEATS,
    sections: SECTIONS,
    ...overrides,
  }
}

export function makeProject(o: { clips?: ClipSpec[]; song?: boolean; analyzed?: boolean } = {}): Project {
  const project = createProject({ name: 'Auto-cut test', now: new Date(0) })
  const assets: Record<string, Asset> = {}
  const visual: Project['analysis']['visual'] = {}
  if (o.song !== false) assets.song = asset('song', 'audio', { duration: SONG_LENGTH })
  ;(o.clips ?? CLIPS).forEach((c, i) => {
    const createdAt = new Date(1000 * (i + 1)).toISOString()
    if (c.image) {
      assets[c.id] = asset(c.id, 'image', { width: 1600, height: 900, createdAt })
    } else {
      assets[c.id] = asset(c.id, 'video', { duration: c.duration, width: 1920, height: 1080, createdAt })
    }
    if (c.indexed !== false) {
      const topic = c.topic === null || c.topic === undefined ? null : (TOPICS[c.topic] as number)
      visual[c.id] = buildVisualAnalysis({
        assetId: c.id,
        duration: c.duration ?? 1,
        sourceSize: { width: 1920, height: 1080 },
        index: clipIndex(c.id, c.duration ?? 1, topic, c.activity ?? 0),
      })
    }
  })
  return {
    ...project,
    assets,
    ...(o.song !== false ? { songAssetId: 'song' } : {}),
    analysis: {
      audio: o.song !== false && o.analyzed !== false ? { song: songAnalysis() } : {},
      visual,
    },
    lyrics: { audioAssetId: 'song', source: 'pasted', lines: LYRICS },
  }
}

/** The real matcher over a fake text encoder: a text mentioning a topic embeds onto that topic's axis. */
export function fakeMatcher() {
  const onnx = {
    async embedTexts({ texts }: { texts: string[] }) {
      const data = new Float32Array(
        texts.flatMap((t) => {
          const topic = Object.keys(TOPICS).find((k) => t.toLowerCase().includes(k))
          return unit(topic === undefined ? null : (TOPICS[topic] as number))
        }),
      )
      return { data, dim: DIM }
    },
  } as unknown as OnnxBackend
  return createFootageMatcher({ onnx, model: MODEL })
}
