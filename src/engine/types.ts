/**
 * Engine contracts. The UI and effect plugins code against these.
 *
 * - One deterministic compositor renders both preview and export: render(project, time) on WebGL2.
 * - Playback time comes from the Web Audio clock so picture follows the song.
 * - Effects, transitions, generators and text animations are registered plugins; projects reference them by id, and
 *   the registry's catalog() describes them for the UI and the director.
 */
import type { JobContext } from '../shared/jobs.ts'
import type {
  AspectPreset,
  Asset,
  AudioModulation,
  ParamValue,
  Project,
  Seconds,
  StemName,
  TextStyle,
} from '../model/types.ts'

export interface RenderOptions {
  /**
   * Canvas size for this frame, applied in the same task as the drawing, so a resize never shows a cleared canvas
   * while media is still being prepared (preview quality changes use this).
   */
  size?: { width: number; height: number }
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
  /** Changes whenever the pixels of `source` change, so unchanged frames are not uploaded again. Undefined: always upload. */
  version?: number
}

/** Supplies media frames to the compositor: <video> elements for preview, WebCodecs decoding for export. */
export interface FrameProvider {
  /**
   * Frame of a video asset at `sourceTime` (seconds into the asset). `key` identifies the requesting clip. `rate` is
   * how many source seconds pass per timeline second (the clip's playback rate, 0 for a freeze); real-time providers
   * play the media at that speed. Defaults to 1.
   */
  videoFrame(asset: Asset, sourceTime: Seconds, key: string, rate?: number): Promise<FrameRef | null>
  image(asset: Asset): Promise<FrameRef | null>
  /** Called before each frame's requests with the keys of every video it requests (clips that stay on screen). */
  beginFrame?(keys: string[]): void
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
  /**
   * An image asset id ('' = none). Shaders get it as `sampler2D u_<key>` (premultiplied, top row at v = 0) plus
   * `vec2 u_<key>Size` in pixels, which is (0, 0) when no image is set. Used for LUTs and texture maps.
   */
  | (ParamSpecBase & { type: 'image'; default: ''; role?: 'lut' | 'texture' })

export type PluginKind = 'effect' | 'transition' | 'generator' | 'text-animation'

/** Relative GPU cost per frame: 'low' is a few texture reads per pixel, 'high' is dozens or heavy procedural noise. */
export type PluginCost = 'low' | 'medium' | 'high'

export interface PluginBase {
  /** Stable id stored in projects, e.g. 'blur' or 'visualizer.spectrum'. Never rename once released. */
  id: string
  name: string
  category: string
  description?: string
  params: ParamSpec[]
  /** Search keywords and badges for the library, e.g. 'reactive', 'beat', 'stems', 'retro'. */
  tags?: string[]
  cost?: PluginCost
  /**
   * Audio mappings put on params when the plugin is added from the library, so it reacts to the music out of the box
   * and the mapping shows (and can be changed) in the inspector like any user-made one.
   */
  defaultModulation?: Record<string, AudioModulation[]>
  /** Library thumbnail URL (16:9 image). */
  thumbnail?: string
}

/** Values resolved for one frame: keyframes and audio modulation already applied. */
export type ResolvedParams = Record<string, ParamValue>

export interface AudioStemFrame {
  loudness: number
  bands: number[]
  /** Onset pulse of this stem (1 at an onset, decaying). */
  onset: number
}

export interface AudioFrame {
  loudness: number
  bands: number[]
  onset: number
  beat: number
  /** Pulse on each bar start: the downbeats, or every fourth beat before bars are found. */
  downbeat: number
  /**
   * Position on the beat grid: beats since the first beat (whole number, negative before it) and the 0..1 phase within
   * the current beat. Without beat analysis it follows the detected tempo, or 120 BPM from the song start.
   */
  beatIndex: number
  beatPhase: number
  /** The same for bars (downbeats); without downbeats a bar is four beats. */
  barIndex: number
  barPhase: number
  /**
   * Integral of loudness over song time, in seconds at full loudness: a steadily increasing phase that runs faster in
   * loud passages, for motion that follows the music without jitter. Without analysis it advances at half speed.
   */
  flow: number
  stems: Partial<Record<StemName, AudioStemFrame>>
}

export interface EffectFrameContext {
  time: Seconds
  /** Time relative to the clip start. */
  localTime: Seconds
  width: number
  height: number
  params: ResolvedParams
  /**
   * Audio features at `time` (loudness, bands, onset/beat pulses), from project analysis: of the stem a generator clip
   * reacts to (GeneratorClip.audio), else of the song's mix.
   */
  audio: AudioFrame
}

/**
 * A full-screen GLSL ES 3.00 pass. The source defines `vec4 mainImage(vec2 uv)` and samples the layer with
 * `texture(u_input, uv)`. Colors are premultiplied. Uniforms provided: u_resolution, u_time (clip-local), u_loudness,
 * u_beat, u_onset, u_downbeat, u_bands[16], u_bandCount, u_beatIndex, u_beatPhase, u_barIndex, u_barPhase, u_flow,
 * u_stems and u_stemOnsets (vec4: vocals, drums, bass, other), u_hasStems (0/1), and u_<key> per param (float; vec4
 * for colors; select = option index; boolean = 0/1; image = sampler2D plus vec2 u_<key>Size). Effects run after the
 * clip's fit and transform; mat3 u_canvasToLayer maps uv to the layer's own coordinates (top-left, 0..1 over the clip's
 * media) and u_layerToCanvas maps back. For text clips the layer is the text canvas, including the padding around the
 * words; for adjustment clips it is the whole canvas.
 */
export interface EffectDefinition extends PluginBase {
  kind: 'effect'
  /** The final pass, at canvas size. */
  fragmentShader: string
  /** Intermediate passes that run first, in order, for example a downsampled blur pyramid. */
  passes?: EffectPass[]
  /** Passes the final shader samples (default: the last pass). */
  passInputs?: string[]
  /**
   * Values that depend only on the frame (params, time, audio), computed once per frame on the CPU instead of in every
   * pixel. Each key is set as `u_<key>` in every pass: a number as `float`, 2 to 4 numbers as `vec2` to `vec4`.
   * Declare these uniforms in the shader, with keys that do not clash with param keys. Must be a pure function of the
   * frame, so preview equals export. `frame.width` and `frame.height` are the render size, which is smaller in
   * reduced-size previews: use only their ratio, or scale pixel sizes by `height / 1080`.
   */
  frameUniforms?: (frame: EffectFrameContext) => Record<string, EffectUniformValue>
}

export type EffectUniformValue = number | readonly number[]

/**
 * An intermediate pass of an effect: same uniforms as the effect (u_input is still the layer), plus the outputs of the
 * earlier passes listed in `inputs`, each as `sampler2D u_<id>` and `vec2 u_<id>Size` (pixels). u_resolution stays
 * the canvas size, so pixel math is the same in every pass.
 */
export interface EffectPass {
  /** Names the output; matches `[A-Za-z_][A-Za-z0-9_]*` and must not clash with a param key. */
  id: string
  /** Output size as a fraction of the canvas, in (0, 1] (default 1). */
  scale?: number
  /** Earlier passes this pass samples. */
  inputs?: string[]
  /** Defines `vec4 mainImage(vec2 uv)`. */
  fragmentShader: string
}

/** Defines `vec4 transition(vec2 uv)` using u_from, u_to (premultiplied) and u_progress (0..1, already eased). */
export interface TransitionDefinition extends PluginBase {
  kind: 'transition'
  fragmentShader: string
  /** Suggested length when the transition is added. */
  defaultDuration?: Seconds
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
  tags?: string[]
  cost?: PluginCost
  defaultModulation?: Record<string, AudioModulation[]>
  thumbnail?: string
  /** Transitions only. */
  defaultDuration?: Seconds
}

export interface PluginRegistry {
  register(plugin: PluginDefinition): void
  get(id: string): PluginDefinition | undefined
  list(kind?: PluginKind): PluginDefinition[]
  catalog(kind?: PluginKind): PluginCatalogEntry[]
  subscribe(listener: () => void): () => void
}
