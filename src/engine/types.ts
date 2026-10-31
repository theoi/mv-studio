/**
 * Engine contracts (implementation lands in the engine milestone). The UI and effect plugins code against these.
 *
 * - One deterministic compositor renders both preview and export: render(project, time) on WebGL2.
 * - Playback time comes from the Web Audio clock so picture follows the song.
 * - Effects, transitions, generators and text animations are registered plugins; projects reference them by id.
 */
import type { JobContext } from '../shared/jobs.ts'
import type { AspectPreset, Id, ParamValue, Project, Seconds } from '../model/types.ts'

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
// Plugin registry contracts (effects, transitions, generators/visualizers, text animation presets)

export type ParamSpec =
  | {
      key: string
      label: string
      type: 'number'
      default: number
      min: number
      max: number
      step?: number
      animatable?: boolean
    }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'color'; default: string; animatable?: boolean }
  | {
      key: string
      label: string
      type: 'select'
      default: string
      options: { value: string; label: string }[]
    }

export interface PluginBase {
  /** Stable id stored in projects, e.g. 'blur' or 'visualizer.spectrum'. Never rename once released. */
  id: string
  name: string
  category: string
  params: ParamSpec[]
  /** Collapsed under "Advanced" in the inspector. */
  advancedParams?: string[]
}

/** Values resolved for one frame: keyframes and audio modulation already applied. */
export type ResolvedParams = Record<string, ParamValue>

export interface EffectFrameContext {
  time: Seconds
  /** Time relative to the clip start. */
  localTime: Seconds
  width: number
  height: number
  params: ResolvedParams
  /** Per-frame audio features at `time` (loudness, bands, onset/beat pulses), from project analysis. */
  audio: AudioFrame
}

export interface AudioFrame {
  loudness: number
  bands: number[]
  onset: number
  beat: number
  downbeat: number
  stems: Partial<Record<'vocals' | 'drums' | 'bass' | 'other', { loudness: number; bands: number[] }>>
}

/** A full-screen GLSL ES 3.00 fragment pass. Sampler `u_input` is the layer below; uniforms are named `u_<param>`. */
export interface EffectDefinition extends PluginBase {
  kind: 'effect'
  fragmentShader: string
}

export interface TransitionDefinition extends PluginBase {
  kind: 'transition'
  /** Samplers `u_from`, `u_to`; float `u_progress` 0..1. */
  fragmentShader: string
}

export interface GeneratorDefinition extends PluginBase {
  kind: 'generator'
  /** Either a shader (sampler-free, uniforms `u_time`, `u_resolution`, `u_<param>`, audio uniforms) or a 2D canvas painter. */
  fragmentShader?: string
  draw2d?: (ctx: OffscreenCanvasRenderingContext2D, frame: EffectFrameContext) => void
}

export type PluginDefinition = EffectDefinition | TransitionDefinition | GeneratorDefinition

export interface PluginRegistry {
  register(plugin: PluginDefinition): void
  get(id: string): PluginDefinition | undefined
  list(kind?: PluginDefinition['kind']): PluginDefinition[]
}

export type ClipId = Id
