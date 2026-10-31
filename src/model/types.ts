/**
 * MV Studio project model, schema version 1. A project is plain JSON: it is saved to IndexedDB, bundled into the
 * portable project file, and rendered identically by preview and export. Change it only through edit commands
 * (./commands.ts) so every change is undoable and AI features produce ordinary editable content.
 *
 * Conventions:
 * - Times are seconds (float). Timeline times are absolute; keyframe times are relative to the clip start.
 * - Positions are normalized to the canvas (0..1, 0.5 = center) so projects survive aspect changes and reframing.
 * - Colors are CSS hex strings ('#rrggbb' or '#rrggbbaa').
 * - Ids are opaque strings (crypto.randomUUID()).
 * Schema changes need a migration in ./migrations.ts and a PROJECT_SCHEMA_VERSION bump.
 */

export type Id = string
export type Seconds = number

export const PROJECT_SCHEMA_VERSION = 1

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------------------------------------------
// Settings

export type AspectPreset = '16:9' | '9:16' | '1:1' | '4:5'

export interface ProjectSettings {
  aspect: AspectPreset
  /** Canvas size in pixels used for preview and as the default export size. */
  width: number
  height: number
  fps: number
  backgroundColor: string
}

// ---------------------------------------------------------------------------------------------------------------
// Assets (media files). The bytes live in the media store (src/media); the project only references them.

export type AssetKind = 'audio' | 'video' | 'image' | 'font'

export interface AssetOrigin {
  type: 'import' | 'generated' | 'stem' | 'recording' | 'derived'
  /** For generated assets, e.g. 'fal-ai/flux/schnell'. */
  provider?: string
  prompt?: string
  /** For stems, proxies and masks: the asset this one was derived from. */
  parentAssetId?: Id
}

export interface Asset {
  id: Id
  kind: AssetKind
  name: string
  mimeType: string
  byteSize: number
  /** Key in the media store (OPFS path); resolved by src/media. */
  storageKey: string
  duration?: Seconds
  width?: number
  height?: number
  frameRate?: number
  hasAudio?: boolean
  sampleRate?: number
  channels?: number
  origin: AssetOrigin
  createdAt: string
}

// ---------------------------------------------------------------------------------------------------------------
// Tracks. project.tracks[0] is the top-most layer (drawn last). Visual tracks hold visual clips; audio tracks hold
// audio clips.

export type TrackKind = 'visual' | 'audio'

export interface Track {
  id: Id
  kind: TrackKind
  name: string
  muted: boolean
  solo: boolean
  locked: boolean
  /** Visual tracks only: excluded from preview and export. */
  hidden: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Animation: every animatable parameter is { value, keyframes?, modulation? }.

export type Easing =
  | 'linear'
  | 'hold'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number }

export interface Keyframe<T = number> {
  /** Seconds from the clip start. */
  time: Seconds
  value: T
  /** Easing of the segment from this keyframe to the next. */
  easing: Easing
}

export type StemName = 'vocals' | 'drums' | 'bass' | 'other'

/** A per-frame audio feature from the project's analysis data (see AudioAnalysis). */
export type AudioFeatureSource =
  | { kind: 'loudness'; stem?: StemName }
  | { kind: 'band'; band: number; stem?: StemName }
  | { kind: 'onset'; stem?: StemName }
  | { kind: 'beat' }
  | { kind: 'downbeat' }

/** Drives a numeric parameter from the music. Evaluated from precomputed analysis so preview equals export. */
export interface AudioModulation {
  source: AudioFeatureSource
  /** Defaults to project.songAssetId. */
  audioAssetId?: Id
  /** Feature value (0..1) times amount is added to, or multiplied with, the parameter. */
  amount: number
  mode: 'add' | 'multiply'
  /** 0 = raw, towards 1 = smoother (attack/release smoothing). */
  smoothing: number
}

export interface Animatable<T = number> {
  value: T
  keyframes?: Keyframe<T>[]
  modulation?: AudioModulation[]
}

export type ParamValue =
  number | boolean | string | [number, number] | [number, number, number] | [number, number, number, number]

// ---------------------------------------------------------------------------------------------------------------
// Visual properties

export interface Transform {
  /** Anchor position on the canvas, normalized (0.5, 0.5 = center). */
  x: Animatable
  y: Animatable
  /** 1 = the clip's natural fitted size (see MediaFit). */
  scaleX: Animatable
  scaleY: Animatable
  /** Degrees, clockwise. */
  rotation: Animatable
  /** Anchor within the layer, normalized (0.5, 0.5 = layer center). */
  anchorX: number
  anchorY: number
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'darken'
  | 'lighten'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'color-dodge'
  | 'color-burn'

/** Neutral values: exposure 0, brightness 0, contrast 0, saturation 0, temperature 0, tint 0, hue 0 (all -1..1). */
export type ColorAdjustmentKey =
  'exposure' | 'brightness' | 'contrast' | 'saturation' | 'temperature' | 'tint' | 'hue'
export type ColorAdjustments = Partial<Record<ColorAdjustmentKey, Animatable>>

/** An effect from the effect registry (src/engine), e.g. 'blur', 'glow', 'rgb-split'. */
export interface EffectInstance {
  id: Id
  effectId: string
  enabled: boolean
  params: Record<string, Animatable<ParamValue>>
}

/**
 * A transition from the transition registry (e.g. 'fade', 'wipe-left', 'zoom', 'flash'). transitionIn covers the
 * clip's first `duration` seconds and transitionOut its last. When a clip with transitionIn starts where another
 * clip on the same track ends, the compositor renders the pair as a cross-transition.
 */
export interface Transition {
  kind: string
  duration: Seconds
  easing: Easing
  params?: Record<string, ParamValue>
}

/** Restricts a clip to the inside or outside of a mask (e.g. lyrics behind the subject). */
export interface Matte {
  /** A mask asset produced by src/vision (grayscale video or image, aligned with sourceAssetId). */
  maskAssetId: Id
  /** The footage asset the mask was computed for, so the mask follows that clip's timing. */
  sourceAssetId: Id
  mode: 'inside' | 'outside'
  feather: number
}

export type MediaFit = 'contain' | 'cover' | 'stretch'

// ---------------------------------------------------------------------------------------------------------------
// Clips

interface ClipBase {
  id: Id
  trackId: Id
  name?: string
  /** Timeline start. */
  start: Seconds
  duration: Seconds
  enabled: boolean
  /** Free-form provenance for features that created the clip (director, VJ, auto-cut). Ignored by the renderer. */
  meta?: JsonObject
}

interface VisualClipBase extends ClipBase {
  transform: Transform
  opacity: Animatable
  blendMode: BlendMode
  adjustments?: ColorAdjustments
  effects: EffectInstance[]
  transitionIn?: Transition
  transitionOut?: Transition
  matte?: Matte
}

export interface VideoClip extends VisualClipBase {
  type: 'video'
  assetId: Id
  /** Offset into the source media at the clip start. */
  sourceStart: Seconds
  playbackRate: number
  fit: MediaFit
  /** Volume of the clip's own audio (0..1+). */
  volume: Animatable
  muted: boolean
}

export interface ImageClip extends VisualClipBase {
  type: 'image'
  assetId: Id
  fit: MediaFit
}

export interface TextStyle {
  fontFamily: string
  /** When the font is an imported font asset. */
  fontAssetId?: Id
  /** Pixels at a 1080-pixel-tall canvas; scaled proportionally for other sizes. */
  fontSize: number
  fontWeight: number
  italic: boolean
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
  /** Wrap width as a fraction of the canvas width. */
  maxWidth: number
  textTransform: 'none' | 'uppercase' | 'lowercase'
  stroke?: { color: string; width: number }
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number }
  background?: { color: string; padding: number; radius: number }
}

export interface TextClip extends VisualClipBase {
  type: 'text'
  text: string
  style: TextStyle
  /** Links the clip to a lyrics line so word timings drive karaoke highlighting and kinetic presets. */
  lyricLineId?: Id
  /** Kinetic typography preset from the typography registry. */
  animation?: { presetId: string; params: Record<string, ParamValue> }
  karaoke?: { highlightColor: string; mode: 'word' | 'line' }
}

export interface SolidClip extends VisualClipBase {
  type: 'solid'
  color: Animatable<string>
}

/** Procedural visuals from the generator registry: visualizers, particles, shader visuals. */
export interface GeneratorClip extends VisualClipBase {
  type: 'generator'
  generatorId: string
  params: Record<string, Animatable<ParamValue>>
}

/** Applies its adjustments and effects to everything composited beneath it (used by looks). */
export interface AdjustmentClip extends VisualClipBase {
  type: 'adjustment'
}

export interface AudioClip extends ClipBase {
  type: 'audio'
  assetId: Id
  sourceStart: Seconds
  playbackRate: number
  volume: Animatable
  muted: boolean
  fadeIn: Seconds
  fadeOut: Seconds
}

export type VisualClip = VideoClip | ImageClip | TextClip | SolidClip | GeneratorClip | AdjustmentClip
export type Clip = VisualClip | AudioClip
export type ClipType = Clip['type']

// ---------------------------------------------------------------------------------------------------------------
// Markers, analysis, lyrics

export interface Marker {
  id: Id
  time: Seconds
  duration?: Seconds
  kind: 'user' | 'cue'
  label: string
  color?: string
}

/** A uniformly sampled feature curve: values[i] is at time i / rate. */
export interface FeatureSeries {
  rate: number
  values: number[]
}

export interface SongSection {
  id: Id
  start: Seconds
  end: Seconds
  /** Best guess ('intro', 'verse', 'chorus', 'bridge', 'outro') or a user-entered name. */
  label: string
  /** Sections with the same group id repeat (e.g. every chorus). */
  repeatGroup?: number
  energy?: number
}

/** Per-frame features consumed by audio-reactive modulation. bands[i] holds one value per band at time i / rate. */
export interface AudioFeatures {
  rate: number
  loudness: number[]
  bands: number[][]
  bandEdgesHz: number[]
  onsets: Seconds[]
}

/**
 * Song analysis results (owned by src/analysis; the field definitions here are the shared contract). Plain data, so
 * preview and export read identical values.
 */
export interface AudioAnalysis {
  assetId: Id
  /** Analyzer version; results with an older version can be recomputed. */
  version: string
  tempo?: { bpm: number; confidence: number }
  beats?: Seconds[]
  downbeats?: Seconds[]
  sections?: SongSection[]
  energy?: FeatureSeries
  features?: AudioFeatures
  stems?: Partial<Record<StemName, Id>>
  stemFeatures?: Partial<Record<StemName, AudioFeatures>>
}

/** Footage analysis results (owned by src/vision; it defines the shape of `data`). */
export interface VisualAnalysis {
  assetId: Id
  version: string
  data: JsonObject
}

export interface LyricWord {
  text: string
  start: Seconds
  end: Seconds
  confidence?: number
}

export interface LyricLine {
  id: Id
  text: string
  start?: Seconds
  end?: Seconds
  words: LyricWord[]
}

export interface LyricsDoc {
  audioAssetId?: Id
  source: 'pasted' | 'transcribed' | 'mixed'
  lines: LyricLine[]
}

// ---------------------------------------------------------------------------------------------------------------
// Project

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  id: Id
  name: string
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  /** The main song: default source for the beat grid, waveform and audio-reactive effects. */
  songAssetId?: Id
  assets: Record<Id, Asset>
  tracks: Track[]
  clips: Record<Id, Clip>
  markers: Marker[]
  analysis: {
    audio: Record<Id, AudioAnalysis>
    visual: Record<Id, VisualAnalysis>
  }
  lyrics?: LyricsDoc
  /** Explicit project length; otherwise the end of the last clip. */
  duration?: Seconds
}
