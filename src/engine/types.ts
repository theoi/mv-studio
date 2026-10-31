/**
 * Engine contracts. The UI and effect plugins code against these.
 *
 * - One deterministic compositor renders both preview and export: render(project, time) on WebGL2.
 * - Playback time comes from the Web Audio clock so picture follows the song.
 * - Effects, transitions, generators and text animations are registered plugins; projects reference them by id, and
 *   the registry's catalog() describes them for the UI and the director.
 */
import type { JobContext } from '../shared/jobs.ts'
import type { AspectPreset, Asset, ParamValue, Project, Seconds, TextStyle } from '../model/types.ts'

export interface RenderOptions {
  /** Preview may render at reduced resolution while scrubbing; export always uses full quality. */
  quality: 'draft' | 'full'
}

export interface Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  resize(width: number, height: number): void
  /** Draws the frame at `time`. Resolves once every media frame it needs is decoded and drawn. */
  render(project: Project, time: Seconds, options?: RenderOptions): Promise<void>
  dispose(): void
}

/** Reads media bytes for an asset (the media store implements this). */
export interface MediaFileSource {
  getFile(asset: Asset): Promise<Blob>
}

/** A decoded frame ready for texture upload. */
export interface FrameRef {
  source: TexImageSource
  width: number
  height: number
}

/** Supplies media frames to the compositor: <video> elements for preview, WebCodecs decoding for export. */
export interface FrameProvider {
  /** Frame of a video asset at `sourceTime` (seconds into the asset). `key` identifies the requesting clip. */
  videoFrame(asset: Asset, sourceTime: Seconds, key: string): Promise<FrameRef | null>
  image(asset: Asset): Promise<FrameRef | null>
  /** Called after each rendered frame so per-frame resources can be released. */
  endFrame?(): void
  dispose(): void
}

export type PlaybackState = 'stopped' | 'playing' | 'paused'

export interface PlaybackClock {
  readonly state: PlaybackState
  /** Current timeline time, derived from AudioContext time while playing. */
  currentTime(): Seconds
  play(): Promise<void>
  pause(): void
  seek(time: Seconds): void
  setLoop(range: { start: Seconds; end: Seconds } | null): void
  subscribe(listener: (state: PlaybackState, time: Seconds) => void): () => void
}

export interface ExportSettings {
  width: number
  height: number
  fps: number
  aspect: AspectPreset
  /** Bits per second; defaults scale with resolution. */
  videoBitrate?: number
  audioBitrate?: number
  range?: { start: Seconds; end: Seconds }
}

export interface ExportResult {
  file: File
  durationSeconds: number
  videoCodec: string
  audioCodec: string
}

/** Export runs as a job (progress, cancel, typed errors). */
export type ExportProject = (
  project: Project,
  settings: ExportSettings,
  ctx: JobContext,
) => Promise<ExportResult>

// ---------------------------------------------------------------------------------------------------------------
// Plugins: effects, transitions, generators (visualizers) and text animation presets

interface ParamSpecBase {
  key: string
  label: string
  /** Shown under "Advanced" (collapsed) in the inspector. */
  advanced?: boolean
  description?: string
}

export type ParamSpec =
  | (ParamSpecBase & {
      type: 'number'
      default: number
      min: number
      max: number
      step?: number
      unit?: string
      /** Keyframes allowed (default true). */
      animatable?: boolean
      /** Can be driven by audio features (default true). */
      modulatable?: boolean
    })
  | (ParamSpecBase & { type: 'boolean'; default: boolean })
  | (ParamSpecBase & { type: 'color'; default: string; animatable?: boolean })
  | (ParamSpecBase & { type: 'select'; default: string; options: { value: string; label: string }[] })

export type PluginKind = 'effect' | 'transition' | 'generator' | 'text-animation'

export interface PluginBase {
  /** Stable id stored in projects, e.g. 'blur' or 'visualizer.spectrum'. Never rename once released. */
  id: string
  name: string
  category: string
  description?: string
  params: ParamSpec[]
}

/** Values resolved for one frame: keyframes and audio modulation already applied. */
export type ResolvedParams = Record<string, ParamValue>

export interface AudioFrame {
  loudness: number
  bands: number[]
  onset: number
  beat: number
  downbeat: number
  stems: Partial<Record<'vocals' | 'drums' | 'bass' | 'other', { loudness: number; bands: number[] }>>
}

export interface EffectFrameContext {
  time: Seconds
  /** Time relative to the clip start. */
  localTime: Seconds
  width: number
  height: number
  params: ResolvedParams
  /** Audio features at `time` (loudness, bands, onset/beat pulses), from project analysis. */
  audio: AudioFrame
}

/**
 * A full-screen GLSL ES 3.00 pass. The source defines `vec4 mainImage(vec2 uv)` and samples the layer with
 * `texture(u_input, uv)`. Colors are premultiplied. Uniforms provided: u_resolution, u_time (clip-local), u_loudness,
 * u_beat, u_onset, u_downbeat, u_bands[16], u_bandCount, and u_<key> per param (float; vec4 for colors; select =
 * option index; boolean = 0/1).
 */
export interface EffectDefinition extends PluginBase {
  kind: 'effect'
  fragmentShader: string
}

/** Defines `vec4 transition(vec2 uv)` using u_from, u_to (premultiplied) and u_progress (0..1, already eased). */
export interface TransitionDefinition extends PluginBase {
  kind: 'transition'
  fragmentShader: string
}

/** Procedural visuals: a shader defining `vec4 mainImage(vec2 uv)` (premultiplied) or a 2D canvas painter. */
export interface GeneratorDefinition extends PluginBase {
  kind: 'generator'
  fragmentShader?: string
  draw2d?: (ctx: OffscreenCanvasRenderingContext2D, frame: EffectFrameContext) => void
}

export interface TextLayoutWord {
  text: string
  /** Left edge and baseline-centered y of the word in the text canvas, in pixels. */
  x: number
  y: number
  width: number
  line: number
  index: number
  /** Timeline times from linked lyrics, when available. */
  start?: Seconds
  end?: Seconds
}

export interface TextLayout {
  width: number
  height: number
  font: string
  fontPx: number
  lineHeightPx: number
  words: TextLayoutWord[]
  lines: { x: number; y: number; width: number; text: string }[]
}

export interface TextAnimationFrame extends EffectFrameContext {
  duration: Seconds
  /** Karaoke highlight color when the clip has karaoke enabled. */
  highlightColor?: string
  karaokeMode?: 'word' | 'line'
}

export interface TextDrawHelpers {
  /** Draws one word with the clip's style (stroke, shadow), optionally transformed around its center. */
  drawWord(
    word: TextLayoutWord,
    options?: {
      color?: string
      alpha?: number
      dx?: number
      dy?: number
      scale?: number
      rotation?: number
      chars?: number
    },
  ): void
}

/** Kinetic typography preset. Draws the laid-out text for one frame; the default draws all words statically. */
export interface TextAnimationDefinition extends PluginBase {
  kind: 'text-animation'
  /** Extra canvas padding as a multiple of the font size, for overshoot and motion. */
  padding?: number
  draw(
    ctx: OffscreenCanvasRenderingContext2D,
    layout: TextLayout,
    style: TextStyle,
    frame: TextAnimationFrame,
    helpers: TextDrawHelpers,
  ): void
}

export type PluginDefinition =
  EffectDefinition | TransitionDefinition | GeneratorDefinition | TextAnimationDefinition

/** What the UI inspector and the director need to know about a plugin, without its code. */
export interface PluginCatalogEntry {
  id: string
  kind: PluginKind
  name: string
  category: string
  description?: string
  params: ParamSpec[]
  /** Keys of numeric params that accept keyframes. */
  animatable: string[]
  /** Keys of numeric params that can be driven by audio features. */
  modulatable: string[]
}

export interface PluginRegistry {
  register(plugin: PluginDefinition): void
  get(id: string): PluginDefinition | undefined
  list(kind?: PluginKind): PluginDefinition[]
  catalog(kind?: PluginKind): PluginCatalogEntry[]
  subscribe(listener: () => void): () => void
}
