/** Factories with sensible defaults for new projects, tracks and clips. */
import {
  PROJECT_SCHEMA_VERSION,
  type Animatable,
  type AspectPreset,
  type AudioClip,
  type Id,
  type ImageClip,
  type Project,
  type ProjectSettings,
  type Seconds,
  type SolidClip,
  type TextClip,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transform,
  type VideoClip,
} from './types.ts'

export const newId = (): Id => crypto.randomUUID()

export const ASPECT_PRESETS: Record<AspectPreset, { width: number; height: number; label: string }> = {
  '16:9': { width: 1920, height: 1080, label: 'Landscape 16:9' },
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1' },
  '4:5': { width: 1080, height: 1350, label: 'Portrait 4:5' },
}

export function settingsForAspect(aspect: AspectPreset, fps = 30): ProjectSettings {
  const { width, height } = ASPECT_PRESETS[aspect]
  return { aspect, width, height, fps, backgroundColor: '#000000' }
}

export const anim = <T>(value: T): Animatable<T> => ({ value })

export function defaultTransform(): Transform {
  return {
    x: anim(0.5),
    y: anim(0.5),
    scaleX: anim(1),
    scaleY: anim(1),
    rotation: anim(0),
    anchorX: 0.5,
    anchorY: 0.5,
  }
}

export function createTrack(kind: TrackKind, name?: string): Track {
  return {
    id: newId(),
    kind,
    name: name ?? (kind === 'audio' ? 'Audio' : 'Video'),
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
  }
}

export function createProject(
  options: { name?: string; aspect?: AspectPreset; fps?: number; now?: Date } = {},
): Project {
  const stamp = (options.now ?? new Date()).toISOString()
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId(),
    name: options.name ?? 'Untitled video',
    createdAt: stamp,
    updatedAt: stamp,
    settings: settingsForAspect(options.aspect ?? '16:9', options.fps),
    assets: {},
    tracks: [createTrack('visual', 'Video 1'), createTrack('audio', 'Song')],
    clips: {},
    markers: [],
    analysis: { audio: {}, visual: {} },
  }
}

function visualBase(trackId: Id, start: Seconds, duration: Seconds) {
  return {
    id: newId(),
    trackId,
    start,
    duration,
    enabled: true,
    transform: defaultTransform(),
    opacity: anim(1),
    blendMode: 'normal' as const,
    effects: [],
  }
}

export function createVideoClip(o: {
  trackId: Id
  assetId: Id
  start: Seconds
  duration: Seconds
  sourceStart?: Seconds
}): VideoClip {
  return {
    ...visualBase(o.trackId, o.start, o.duration),
    type: 'video',
    assetId: o.assetId,
    sourceStart: o.sourceStart ?? 0,
    playbackRate: 1,
    fit: 'cover',
    volume: anim(1),
    muted: false,
  }
}

export function createImageClip(o: {
  trackId: Id
  assetId: Id
  start: Seconds
  duration: Seconds
}): ImageClip {
  return { ...visualBase(o.trackId, o.start, o.duration), type: 'image', assetId: o.assetId, fit: 'cover' }
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 96,
  fontWeight: 700,
  italic: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  letterSpacing: 0,
  maxWidth: 0.85,
  textTransform: 'none',
}

export function createTextClip(o: {
  trackId: Id
  text: string
  start: Seconds
  duration: Seconds
  style?: Partial<TextStyle>
}): TextClip {
  return {
    ...visualBase(o.trackId, o.start, o.duration),
    type: 'text',
    text: o.text,
    style: { ...DEFAULT_TEXT_STYLE, ...o.style },
  }
}

export function createSolidClip(o: {
  trackId: Id
  color: string
  start: Seconds
  duration: Seconds
}): SolidClip {
  return { ...visualBase(o.trackId, o.start, o.duration), type: 'solid', color: anim(o.color) }
}

export function createAudioClip(o: {
  trackId: Id
  assetId: Id
  start: Seconds
  duration: Seconds
  sourceStart?: Seconds
}): AudioClip {
  return {
    id: newId(),
    trackId: o.trackId,
    start: o.start,
    duration: o.duration,
    enabled: true,
    type: 'audio',
    assetId: o.assetId,
    sourceStart: o.sourceStart ?? 0,
    playbackRate: 1,
    volume: anim(1),
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
  }
}
