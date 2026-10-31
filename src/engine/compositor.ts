/**
 * WebGL2 compositor: draws a project at a timeline time. Preview and export share it and differ only in the frame
 * provider, so export matches preview. Every intermediate image is premultiplied RGBA at canvas size.
 *
 * Per frame: plan the layers (./layout.ts), decode the media they need in parallel, then draw bottom-up into an
 * accumulator. A plain layer (normal blend, no effects, adjustments or matte) is drawn straight into the
 * accumulator; any other layer renders into its own target, runs its effect passes and a finish pass (adjustments,
 * matte, opacity), then blends in. Adjustment clips process the accumulator itself.
 */
import type {
  Animatable,
  Asset,
  BlendMode,
  ColorAdjustmentKey,
  ImageClip,
  ParamValue,
  Project,
  Seconds,
  StemName,
  VideoClip,
  VisualClip,
} from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { ease, evaluate, evaluateNumber } from './animation.ts'
import { createAudioSampler, type AudioSampler } from './audioFeatures.ts'
import { parseColor, type Rgba } from './color.ts'
import {
  createProgram,
  createTexture,
  createUnitQuad,
  TargetPool,
  uploadSource,
  type GL,
  type Program,
  type RenderTarget,
} from './gl.ts'
import { fitSize, layerMatrix, layerUniforms, planFrame, type LayerPlan, type Mat2D } from './layout.ts'
import { pluginRegistry, resolveParams, resolveStaticParams } from './registry.ts'
import {
  BLEND_FS,
  BLEND_MODE_INDEX,
  COPY_FS,
  effectShader,
  FINISH_FS,
  FULLSCREEN_VS,
  generatorShader,
  LAYER_SOLID_FS,
  LAYER_TEXTURE_FS,
  LAYER_VS,
  transitionShader,
} from './shaders.ts'
import { TextRenderer } from './text.ts'
import type {
  AudioFrame,
  Compositor,
  EffectDefinition,
  EffectFrameContext,
  EffectPass,
  EffectUniformValue,
  FrameProvider,
  FrameRef,
  MediaFileSource,
  ParamSpec,
  PluginDefinition,
  PluginRegistry,
  RenderOptions,
  ResolvedParams,
} from './types.ts'

export interface CompositorOptions {
  /** Defaults to a new detached <canvas> (or an OffscreenCanvas in workers). */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  frames: FrameProvider
  /** Reads font files for text clips that use imported fonts. */
  media: MediaFileSource
  registry?: PluginRegistry
  /** Keep the last frame readable (readPixels, toBlob) after render() resolves. */
  preserveDrawingBuffer?: boolean
}

const ADJUSTMENT_KEYS: ColorAdjustmentKey[] = [
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'hue',
]
const BAND_UNIFORMS = 16
const TEXTURE_IDLE_FRAMES = 300
const STEM_ORDER: StemName[] = ['vocals', 'drums', 'bass', 'other']
/** Texture units 0 and 1 hold a plugin's own inputs (u_input, or u_from and u_to); image params start here. */
const FIRST_IMAGE_PARAM_UNIT = 2
/** Texture creation and uploads happen on this unit, so they never disturb textures bound for the current pass. */
const SCRATCH_UNIT = 15
const BUNDLED_PREFIX = 'bundled:'

/**
 * URL of an image param that refers to a file shipped with the app (`bundled:luts/film.png` is served from
 * public/luts/film.png), or null for anything else (asset ids).
 */
export function bundledImageUrl(ref: string): string | null {
  if (!ref.startsWith(BUNDLED_PREFIX)) return null
  const path = ref.slice(BUNDLED_PREFIX.length).replace(/^\/+/, '')
  return path ? `${import.meta.env.BASE_URL}${path}` : null
}

const imageParamKey = (ref: string) => `param:${ref}`

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

const NO_FRAME_UNIFORMS: Readonly<Record<string, EffectUniformValue>> = {}

/** Passes an effect's final shader samples. */
const finalInputs = (def: EffectDefinition): readonly string[] =>
  def.passInputs ?? (def.passes?.length ? [def.passes[def.passes.length - 1]!.id] : [])

interface FrameState {
  project: Project
  time: Seconds
  width: number
  height: number
  audio: AudioSampler
  audioFrame: AudioFrame
  bands: Float32Array
  sources: Map<string, FrameRef | null>
}

type QuadContent = { texture: WebGLTexture; flipY: boolean } | { color: Rgba }

interface Programs {
  layerTexture: Program
  layerSolid: Program
  copy: Program
  finish: Program
  blend: Program
}

interface GpuState {
  programs: Programs
  pool: TargetPool
  quad: WebGLVertexArrayObject
  transparent: WebGLTexture
  /** Compiled programs by plugin definition or effect pass; null when compilation failed. */
  plugins: WeakMap<PluginDefinition | EffectPass, Program | null>
  textures: Map<string, { texture: WebGLTexture; version: unknown; lastUsed: number }>
}

/**
 * A clip's matte with the on-screen clip of its source footage, which the mask follows in time and transform. Null when
 * that footage is not on screen at `time`: the mask only describes that footage, so the clip then draws unmasked.
 */
function matteSource(project: Project, clip: VisualClip, time: Seconds) {
  const matte = clip.matte
  const maskAsset = matte ? project.assets[matte.maskAssetId] : undefined
  if (!matte || !maskAsset) return null
  const isHost = (c: VisualClip | Project['clips'][string]): c is VideoClip | ImageClip =>
    (c.type === 'video' || c.type === 'image') && c.assetId === matte.sourceAssetId
  let host: VideoClip | ImageClip | undefined = isHost(clip) ? clip : undefined
  if (!host) {
    const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id))
    for (const c of Object.values(project.clips)) {
      if (
        c.enabled &&
        isHost(c) &&
        !hidden.has(c.trackId) &&
        time >= c.start &&
        time < c.start + c.duration
      ) {
        host = c
        break
      }
    }
  }
  if (!host) return null
  const sourceTime = host.type === 'video' ? host.sourceStart + (time - host.start) * host.playbackRate : 0
  const rate = host.type === 'video' ? host.playbackRate : 0
  return { matte, maskAsset, host, sourceTime, rate }
}

/** Layer matrix of a clip whose drawn size is known without decoding it, or null (text, unknown media size). */
function knownLayerMatrix(
  clip: VisualClip,
  project: Project,
  time: Seconds,
  canvas: { width: number; height: number },
  audio: AudioSampler,
): Mat2D | null {
  const { width, height } = canvas
  let size: [number, number] | null = null
  if (clip.type === 'solid' || clip.type === 'generator') size = [width, height]
  else if (clip.type === 'video' || clip.type === 'image') {
    const asset = project.assets[clip.assetId]
    if (asset?.width && asset.height) size = fitSize(clip.fit, asset.width, asset.height, width, height)
  }
  return size && layerMatrix(clip, time - clip.start, time, size[0], size[1], width, height, audio)
}

/** Whether a clip paints every canvas pixel with full opacity, hiding everything below it. */
function coversCanvas(
  clip: VisualClip,
  project: Project,
  time: Seconds,
  canvas: { width: number; height: number },
  audio: AudioSampler,
): boolean {
  if (clip.blendMode !== 'normal' || clip.effects.some((e) => e.enabled) || clip.matte) return false
  const local = time - clip.start
  if (evaluateNumber(clip.opacity, local, time, audio) < 1) return false
  if (clip.type === 'solid') {
    if (parseColor(evaluate(clip.color, local))[3] < 1) return false
  } else if (clip.type === 'video') {
    // WebM (VP8/VP9) can carry alpha; the other formats browsers decode cannot.
    if (/webm/i.test(project.assets[clip.assetId]?.mimeType ?? 'webm')) return false
  } else if (clip.type === 'image') {
    if (project.assets[clip.assetId]?.mimeType !== 'image/jpeg') return false
  } else return false
  const m = knownLayerMatrix(clip, project, time, canvas, audio)
  if (!m) return false
  const det = m[0] * m[3] - m[2] * m[1]
  if (Math.abs(det) < 1e-9) return false
  const eps = 1e-6
  for (const [x, y] of [
    [0, 0],
    [canvas.width, 0],
    [0, canvas.height],
    [canvas.width, canvas.height],
  ] as const) {
    const dx = x - m[4]
    const dy = y - m[5]
    const u = (m[3] * dx - m[2] * dy) / det
    const v = (m[0] * dy - m[1] * dx) / det
    if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) return false
  }
  return true
}

/** Whether a clip without effects draws nothing on the canvas (fully outside it, or transparent). */
function offCanvas(
  clip: VisualClip,
  project: Project,
  time: Seconds,
  canvas: { width: number; height: number },
  audio: AudioSampler,
): boolean {
  if (clip.type === 'adjustment' || clip.effects.some((e) => e.enabled)) return false
  if (evaluateNumber(clip.opacity, time - clip.start, time, audio) <= 0) return true
  const m = knownLayerMatrix(clip, project, time, canvas, audio)
  if (!m) return false
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
  return (
    Math.max(...xs) <= 0 ||
    Math.min(...xs) >= canvas.width ||
    Math.max(...ys) <= 0 ||
    Math.min(...ys) >= canvas.height
  )
}

/**
 * Drops layers that cannot change the frame: everything below the topmost layer that covers the canvas with opaque
 * pixels, and layers without effects that fall entirely outside the canvas. Their media is then not decoded either.
 * Preview and export share this, so it never changes what is exported.
 */
export function visibleLayers(
  plan: LayerPlan[],
  project: Project,
  time: Seconds,
  canvas: { width: number; height: number },
  audio: AudioSampler,
): LayerPlan[] {
  let start = 0
  for (let i = plan.length - 1; i > 0; i--) {
    const layer = plan[i] as LayerPlan
    if (layer.kind === 'clip' && coversCanvas(layer.clip, project, time, canvas, audio)) {
      start = i
      break
    }
  }
  return plan
    .slice(start)
    .filter((layer) => layer.kind !== 'clip' || !offCanvas(layer.clip, project, time, canvas, audio))
}

/** A video frame one rendered frame needs: a video clip's footage, or the mask video of a clip's matte. */
export interface VideoRequest {
  /** The clip id, or `matte:<clip id>` for a mask. */
  key: string
  asset: Asset
  /** Seconds into the asset. */
  time: Seconds
  rate: number
}

/**
 * The video frames that drawing `plan` at `time` reads, in request order. The worker preview uses it on the main
 * thread to take exactly these frames from its <video> elements.
 */
export function videoRequests(project: Project, plan: LayerPlan[], time: Seconds): VideoRequest[] {
  const out: VideoRequest[] = []
  const visit = (clip: VisualClip | null) => {
    if (!clip) return
    if (clip.type === 'video') {
      const asset = project.assets[clip.assetId]
      if (asset)
        out.push({
          key: clip.id,
          asset,
          time: clip.sourceStart + (time - clip.start) * clip.playbackRate,
          rate: clip.playbackRate,
        })
    }
    const matte = matteSource(project, clip, time)
    if (matte && matte.maskAsset.kind !== 'image')
      out.push({ key: `matte:${clip.id}`, asset: matte.maskAsset, time: matte.sourceTime, rate: matte.rate })
  }
  for (const layer of plan) {
    if (layer.kind === 'transition') {
      visit(layer.from)
      visit(layer.to)
    } else visit(layer.clip)
  }
  return out
}

/** Averages analysis bands into the fixed-size u_bands uniform. */
function bandUniform(bands: readonly number[]): Float32Array {
  const out = new Float32Array(BAND_UNIFORMS)
  if (bands.length <= BAND_UNIFORMS) {
    out.set(bands)
    return out
  }
  for (let i = 0; i < BAND_UNIFORMS; i++) {
    const a = Math.floor((i * bands.length) / BAND_UNIFORMS)
    const b = Math.floor(((i + 1) * bands.length) / BAND_UNIFORMS)
    let sum = 0
    for (let j = a; j < b; j++) sum += bands[j] as number
    out[i] = sum / Math.max(1, b - a)
  }
  return out
}

export class WebGLCompositor implements Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private readonly gl: GL
  private readonly frames: FrameProvider
  private readonly registry: PluginRegistry
  private readonly text: TextRenderer
  private readonly samplers = new WeakMap<Project, AudioSampler>()
  private readonly canvases2d = new Map<string, OffscreenCanvas>()
  private readonly urlImages = new Map<string, Promise<FrameRef | null>>()
  private gpu: GpuState | null
  private frameIndex = 0
  /** Signals when the GPU has finished the last rendered frame. */
  private fence: WebGLSync | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: CompositorOptions) {
    this.canvas =
      options.canvas ??
      (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1))
    this.frames = options.frames
    this.registry = options.registry ?? pluginRegistry
    this.text = new TextRenderer(this.registry, options.media)
    const attributes: WebGLContextAttributes = {
      alpha: false,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    }
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2', attributes) as GL | null
    if (!gl) throw new JobError('unsupported', 'WebGL2 is not available in this browser')
    this.gl = gl
    this.gpu = this.createGpuState()
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.gpu = null
      this.fence = null
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      if (!this.disposed) this.gpu = this.createGpuState()
    })
  }

  /** False while the GPU context is lost; render() then skips drawing until the browser restores it. */
  get ready(): boolean {
    return this.gpu !== null && !this.disposed
  }

  private createGpuState(): GpuState {
    const gl = this.gl
    const transparent = createTexture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    return {
      programs: {
        layerTexture: createProgram(gl, LAYER_VS, LAYER_TEXTURE_FS),
        layerSolid: createProgram(gl, LAYER_VS, LAYER_SOLID_FS),
        copy: createProgram(gl, FULLSCREEN_VS, COPY_FS),
        finish: createProgram(gl, FULLSCREEN_VS, FINISH_FS),
        blend: createProgram(gl, FULLSCREEN_VS, BLEND_FS),
      },
      pool: new TargetPool(gl),
      quad: createUnitQuad(gl),
      transparent,
      plugins: new WeakMap(),
      textures: new Map(),
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
  }

  /**
   * Whether the GPU is still executing the last rendered frame. Real-time callers skip a frame instead of queueing
   * more work: once the GPU falls behind, further WebGL calls block the main thread until it catches up.
   */
  gpuBusy(): boolean {
    const fence = this.fence
    if (!fence || !this.gpu) return false
    if (this.gl.getSyncParameter(fence, this.gl.SYNC_STATUS) !== this.gl.SIGNALED) return true
    this.gl.deleteSync(fence)
    this.fence = null
    return false
  }

  /** Renders are serialized: each waits for the previous one, so overlapping calls never interleave GPU work. */
  render(project: Project, time: Seconds, options?: RenderOptions): Promise<void> {
    const run = this.queue.then(() => this.renderNow(project, time, options))
    this.queue = run.catch(() => undefined)
    return run
  }

  private sampler(project: Project): AudioSampler {
    let s = this.samplers.get(project)
    if (!s) {
      s = createAudioSampler(project)
      this.samplers.set(project, s)
    }
    return s
  }

  private async renderNow(project: Project, time: Seconds, options?: RenderOptions): Promise<void> {
    if (this.disposed) return
    const audio = this.sampler(project)
    const plan = visibleLayers(planFrame(project, time), project, time, options?.size ?? this.canvas, audio)
    const audioFrame = audio.frame(time)
    const sources = await this.prepare(project, plan, time)
    const gpu = this.gpu
    if (this.disposed || !gpu) {
      this.frames.endFrame?.()
      return
    }
    if (options?.size) this.resize(options.size.width, options.size.height)
    const gl = this.gl
    const width = this.canvas.width
    const height = this.canvas.height
    const state: FrameState = {
      project,
      time,
      width,
      height,
      audio,
      audioFrame,
      bands: bandUniform(audioFrame.bands),
      sources,
    }
    try {
      gpu.pool.resize(width, height)
      gl.viewport(0, 0, width, height)
      gl.bindVertexArray(gpu.quad)
      let acc = gpu.pool.acquire()
      const [r, g, b] = parseColor(project.settings.backgroundColor)
      this.clear(acc, [r, g, b, 1])
      for (const layer of plan) acc = this.drawLayer(gpu, layer, acc, state)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.disable(gl.BLEND)
      this.fullscreen(gpu.programs.copy, [['u_tex', acc.texture]])
      if (this.fence) gl.deleteSync(this.fence)
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
    } finally {
      gpu.pool.releaseAll()
      this.frames.endFrame?.()
      this.frameIndex++
      this.sweep(gpu, project)
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Preparation: decode media and load fonts for every layer in the plan, in parallel.

  private async prepare(
    project: Project,
    plan: LayerPlan[],
    time: Seconds,
  ): Promise<Map<string, FrameRef | null>> {
    const sources = new Map<string, FrameRef | null>()
    const tasks: Promise<unknown>[] = []
    const want = (key: string, request: Promise<FrameRef | null>) =>
      tasks.push(
        request.then(
          (frame) => sources.set(key, frame),
          (error: unknown) => {
            console.warn(`Frame for ${key} could not be decoded`, error)
            sources.set(key, null)
          },
        ),
      )
    const images = new Set<string>()
    const wantImages = (specs: readonly ParamSpec[], read: (key: string) => ParamValue | undefined) => {
      for (const spec of specs) {
        if (spec.type !== 'image') continue
        const ref = read(spec.key)
        if (typeof ref !== 'string' || !ref || images.has(ref)) continue
        images.add(ref)
        const request = this.imageParam(project, ref)
        if (request) want(imageParamKey(ref), request)
      }
    }
    const animated = (values: Record<string, Animatable<ParamValue>>, local: Seconds) => (key: string) => {
      const anim = values[key]
      return anim ? evaluate(anim, local) : undefined
    }
    const visit = (clip: VisualClip | null) => {
      if (!clip) return
      const local = time - clip.start
      for (const effect of clip.effects) {
        const def = effect.enabled ? this.registry.get(effect.effectId) : undefined
        if (def?.kind === 'effect') wantImages(def.params, animated(effect.params, local))
      }
      if (clip.type === 'generator') {
        const def = this.registry.get(clip.generatorId)
        if (def?.kind === 'generator') wantImages(def.params, animated(clip.params, local))
      }
      if (clip.type === 'image') {
        const asset = project.assets[clip.assetId]
        if (asset) want(clip.id, this.frames.image(asset))
      } else if (clip.type === 'text') {
        tasks.push(this.text.prepare(clip, project))
      }
      const matte = matteSource(project, clip, time)
      if (matte?.maskAsset.kind === 'image') want(`matte:${clip.id}`, this.frames.image(matte.maskAsset))
    }
    for (const layer of plan) {
      if (layer.kind === 'transition') {
        visit(layer.from)
        visit(layer.to)
        const def = this.registry.get(layer.transition.kind)
        if (def?.kind === 'transition') wantImages(def.params, (key) => layer.transition.params?.[key])
      } else visit(layer.clip)
    }
    // Video requests start after beginFrame() has seen all of them, so the provider knows which clips stay on screen.
    const videos = videoRequests(project, plan, time)
    this.frames.beginFrame?.(videos.map((v) => v.key))
    for (const v of videos) want(v.key, this.frames.videoFrame(v.asset, v.time, v.key, v.rate))
    await Promise.all(tasks)
    return sources
  }

  /** Decoded image for an image param: an image asset of the project, or a file bundled with the app. */
  private imageParam(project: Project, ref: string): Promise<FrameRef | null> | null {
    const asset = project.assets[ref]
    if (asset) return asset.kind === 'image' ? this.frames.image(asset) : null
    const url = bundledImageUrl(ref)
    if (!url) return null
    let image = this.urlImages.get(url)
    if (!image) {
      image = fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.blob()
        })
        // WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps, so premultiply when decoding.
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }))
        .then((bitmap): FrameRef => ({ source: bitmap, width: bitmap.width, height: bitmap.height }))
        .catch((error: unknown) => {
          console.warn(`Image ${url} could not be loaded`, error)
          return null
        })
      this.urlImages.set(url, image)
    }
    return image
  }

  // -------------------------------------------------------------------------------------------------------------
  // Layers

  private drawLayer(gpu: GpuState, layer: LayerPlan, acc: RenderTarget, s: FrameState): RenderTarget {
    switch (layer.kind) {
      case 'clip': {
        const clip = layer.clip
        if (this.isPlain(clip, s)) {
          const opacity = clamp01(evaluateNumber(clip.opacity, s.time - clip.start, s.time, s.audio))
          if (opacity > 0) this.drawContent(gpu, clip, acc, s, opacity)
          return acc
        }
        return this.composite(gpu, acc, this.renderClip(gpu, clip, s), clip.blendMode)
      }
      case 'adjustment':
        return this.composite(gpu, acc, this.process(gpu, layer.clip, acc, false, s), layer.clip.blendMode)
      case 'transition': {
        const from = layer.from ? this.renderClip(gpu, layer.from, s) : null
        const to = layer.to ? this.renderClip(gpu, layer.to, s) : null
        const out = this.transition(gpu, layer, from, to, s)
        const mode = (layer.to ?? layer.from)?.blendMode ?? 'normal'
        return this.composite(gpu, acc, out, mode)
      }
    }
  }

  /** Plain layers draw straight into the accumulator with premultiplied "over" blending. */
  private isPlain(clip: VisualClip, s: FrameState): boolean {
    return (
      clip.blendMode === 'normal' &&
      !clip.effects.some((e) => e.enabled) &&
      !matteSource(s.project, clip, s.time) &&
      this.adjustments(clip, s) === null
    )
  }

  private renderClip(gpu: GpuState, clip: VisualClip, s: FrameState): RenderTarget {
    const target = gpu.pool.acquire()
    this.clear(target, [0, 0, 0, 0])
    const layer = this.drawContent(gpu, clip, target, s, 1)
    return this.process(gpu, clip, target, true, s, layer)
  }

  /** Effect passes, then adjustments, matte and opacity. Returns a target owned by the caller. */
  private process(
    gpu: GpuState,
    clip: VisualClip,
    input: RenderTarget,
    ownsInput: boolean,
    s: FrameState,
    layer: Mat2D | null = null,
  ): RenderTarget {
    const gl = this.gl
    const local = s.time - clip.start
    let current = input
    let owned = ownsInput
    const mapping = layerUniforms(layer, s.width, s.height)
    for (const instance of clip.effects) {
      if (!instance.enabled) continue
      const def = this.registry.get(instance.effectId)
      if (def?.kind !== 'effect') continue
      const program = this.pluginProgram(gpu, def)
      const passes = (def.passes ?? []).map((pass) => this.passProgram(gpu, def, pass))
      if (!program || passes.some((p) => !p)) continue
      const params = resolveParams(def.params, instance.params, local, s.time, s.audio)
      const values =
        def.frameUniforms?.({
          time: s.time,
          localTime: local,
          width: s.width,
          height: s.height,
          params,
          audio: s.audioFrame,
        }) ?? NO_FRAME_UNIFORMS
      const outputs = new Map<string, RenderTarget>()
      ;(def.passes ?? []).forEach((pass, i) => {
        const scale = pass.scale ?? 1
        const out = gpu.pool.acquire(
          Math.max(1, Math.round(s.width * scale)),
          Math.max(1, Math.round(s.height * scale)),
        )
        gl.viewport(0, 0, out.width, out.height)
        this.effectPass(
          gpu,
          passes[i] as Program,
          def,
          params,
          current,
          pass.inputs ?? [],
          outputs,
          out,
          mapping,
          values,
          local,
          s,
        )
        outputs.set(pass.id, out)
      })
      gl.viewport(0, 0, s.width, s.height)
      const out = gpu.pool.acquire()
      this.effectPass(
        gpu,
        program,
        def,
        params,
        current,
        finalInputs(def),
        outputs,
        out,
        mapping,
        values,
        local,
        s,
      )
      for (const target of outputs.values()) gpu.pool.release(target)
      if (owned) gpu.pool.release(current)
      current = out
      owned = true
    }

    const opacity = clamp01(evaluateNumber(clip.opacity, local, s.time, s.audio))
    const adjust = this.adjustments(clip, s)
    const matte = this.matteTarget(gpu, clip, s)
    if (owned && opacity === 1 && !adjust && !matte) return current

    const out = gpu.pool.acquire()
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
    gl.disable(gl.BLEND)
    const p = gpu.programs.finish
    gl.useProgram(p.program)
    this.bindTexture(p, 'u_tex', 0, current.texture)
    this.bindTexture(p, 'u_matte', 1, matte?.target.texture ?? gpu.transparent)
    gl.uniform1i(p.uniform('u_matteMode'), matte ? (matte.mode === 'inside' ? 1 : 2) : 0)
    gl.uniform1f(p.uniform('u_feather'), clamp01(matte?.feather ?? 0))
    gl.uniform1f(p.uniform('u_opacity'), opacity)
    gl.uniform1i(p.uniform('u_adjust'), adjust ? 1 : 0)
    for (const key of ADJUSTMENT_KEYS) gl.uniform1f(p.uniform(`u_${key}`), adjust?.[key] ?? 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    if (owned) gpu.pool.release(current)
    if (matte) gpu.pool.release(matte.target)
    return out
  }

  /** Draws one pass of an effect into `out` (the viewport must match it). */
  private effectPass(
    gpu: GpuState,
    program: Program,
    def: EffectDefinition,
    params: ResolvedParams,
    input: RenderTarget,
    inputs: readonly string[],
    outputs: ReadonlyMap<string, RenderTarget>,
    out: RenderTarget,
    mapping: ReturnType<typeof layerUniforms>,
    values: Readonly<Record<string, EffectUniformValue>>,
    local: Seconds,
    s: FrameState,
  ): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
    gl.disable(gl.BLEND)
    gl.useProgram(program.program)
    this.setCommonUniforms(program, local, s)
    gl.uniformMatrix3fv(program.uniform('u_canvasToLayer'), false, mapping.canvasToLayer)
    gl.uniformMatrix3fv(program.uniform('u_layerToCanvas'), false, mapping.layerToCanvas)
    this.setFrameUniforms(program, values)
    this.setParamUniforms(program, def.params, params)
    this.bindImageParams(gpu, program, def.params, params, s)
    this.bindTexture(program, 'u_input', 0, input.texture)
    let unit = FIRST_IMAGE_PARAM_UNIT + def.params.filter((p) => p.type === 'image').length
    for (const id of inputs) {
      const target = outputs.get(id)
      if (!target) continue
      this.bindTexture(program, `u_${id}`, unit++, target.texture)
      gl.uniform2f(program.uniform(`u_${id}Size`), target.width, target.height)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private adjustments(clip: VisualClip, s: FrameState): Record<ColorAdjustmentKey, number> | null {
    if (!clip.adjustments) return null
    const local = s.time - clip.start
    const out = {} as Record<ColorAdjustmentKey, number>
    let any = false
    for (const key of ADJUSTMENT_KEYS) {
      const anim = clip.adjustments[key]
      const v = anim ? Math.max(-1, Math.min(1, evaluateNumber(anim, local, s.time, s.audio))) : 0
      out[key] = v
      if (v !== 0) any = true
    }
    return any ? out : null
  }

  /** The mask drawn where its source footage appears on the canvas (so it tracks that clip's transform). */
  private matteTarget(
    gpu: GpuState,
    clip: VisualClip,
    s: FrameState,
  ): { target: RenderTarget; mode: 'inside' | 'outside'; feather: number } | null {
    const info = matteSource(s.project, clip, s.time)
    const frame = s.sources.get(`matte:${clip.id}`)
    if (!info || !frame || frame.width === 0) return null
    const target = gpu.pool.acquire()
    this.clear(target, [0, 0, 0, 0])
    const texture = this.texture(
      gpu,
      `matte:${clip.id}`,
      frame.source,
      info.maskAsset.kind === 'image' ? frame.source : frame.version,
    )
    const { host } = info
    const src = s.project.assets[host.assetId]
    const [bw, bh] = fitSize(
      host.fit,
      src?.width ?? frame.width,
      src?.height ?? frame.height,
      s.width,
      s.height,
    )
    const m = layerMatrix(host, s.time - host.start, s.time, bw, bh, s.width, s.height, s.audio)
    this.drawQuad(gpu, target, m, { texture, flipY: false }, 1, s)
    return { target, mode: info.matte.mode, feather: info.matte.feather }
  }

  private transition(
    gpu: GpuState,
    layer: Extract<LayerPlan, { kind: 'transition' }>,
    from: RenderTarget | null,
    to: RenderTarget | null,
    s: FrameState,
  ): RenderTarget {
    const gl = this.gl
    let def = this.registry.get(layer.transition.kind)
    if (def?.kind !== 'transition') def = this.registry.get('fade')
    const program = def?.kind === 'transition' ? this.pluginProgram(gpu, def) : null
    const out = gpu.pool.acquire()
    if (!program || def?.kind !== 'transition') {
      this.clear(out, [0, 0, 0, 0])
      return out
    }
    const clip = layer.to ?? layer.from
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
    gl.disable(gl.BLEND)
    gl.useProgram(program.program)
    this.setCommonUniforms(program, clip ? s.time - clip.start : 0, s)
    const params = resolveStaticParams(def.params, layer.transition.params)
    this.setParamUniforms(program, def.params, params)
    this.bindImageParams(gpu, program, def.params, params, s)
    gl.uniform1f(program.uniform('u_progress'), ease(layer.transition.easing, clamp01(layer.progress)))
    this.bindTexture(program, 'u_from', 0, from?.texture ?? gpu.transparent)
    this.bindTexture(program, 'u_to', 1, to?.texture ?? gpu.transparent)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    if (from) gpu.pool.release(from)
    if (to) gpu.pool.release(to)
    return out
  }

  /** Blends `src` into the accumulator and releases it. May return a new accumulator. */
  private composite(gpu: GpuState, acc: RenderTarget, src: RenderTarget, mode: BlendMode): RenderTarget {
    const gl = this.gl
    if (mode === 'normal') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      this.fullscreen(gpu.programs.copy, [['u_tex', src.texture]])
      gpu.pool.release(src)
      return acc
    }
    const out = gpu.pool.acquire()
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
    gl.disable(gl.BLEND)
    const p = gpu.programs.blend
    gl.useProgram(p.program)
    gl.uniform1i(p.uniform('u_mode'), BLEND_MODE_INDEX[mode] ?? 0)
    this.fullscreen(p, [
      ['u_dst', acc.texture],
      ['u_src', src.texture],
    ])
    gpu.pool.release(acc)
    gpu.pool.release(src)
    return out
  }

  // -------------------------------------------------------------------------------------------------------------
  // Content

  /** Draws a clip's own pixels, transformed, into `target`. Returns its layer matrix, or null when nothing was drawn. */
  private drawContent(
    gpu: GpuState,
    clip: VisualClip,
    target: RenderTarget,
    s: FrameState,
    opacity: number,
  ): Mat2D | null {
    const local = s.time - clip.start
    const matrix = (bw: number, bh: number) =>
      layerMatrix(clip, local, s.time, bw, bh, s.width, s.height, s.audio)
    switch (clip.type) {
      case 'video':
      case 'image': {
        const frame = s.sources.get(clip.id)
        if (!frame || frame.width === 0 || frame.height === 0) return null
        const key = clip.type === 'image' ? `image:${clip.assetId}` : `video:${clip.id}`
        const texture = this.texture(
          gpu,
          key,
          frame.source,
          clip.type === 'image' ? frame.source : frame.version,
        )
        const [bw, bh] = fitSize(clip.fit, frame.width, frame.height, s.width, s.height)
        const m = matrix(bw, bh)
        this.drawQuad(gpu, target, m, { texture, flipY: false }, opacity, s)
        return m
      }
      case 'solid': {
        const color = parseColor(evaluate(clip.color, local))
        const m = matrix(s.width, s.height)
        this.drawQuad(gpu, target, m, { color }, opacity, s)
        return m
      }
      case 'text': {
        if (!clip.text.trim()) return null
        const raster = this.text.draw(clip, s.project, s.time, s.width, s.height, s.audioFrame)
        const texture = this.texture(gpu, `text:${clip.id}`, raster.canvas, raster.version)
        const m = matrix(raster.width, raster.height)
        this.drawQuad(gpu, target, m, { texture, flipY: false }, opacity, s)
        return m
      }
      case 'generator': {
        const m = matrix(s.width, s.height)
        return this.drawGenerator(gpu, clip, target, s, opacity, m) ? m : null
      }
      case 'adjustment':
        return null
    }
  }

  private drawGenerator(
    gpu: GpuState,
    clip: Extract<VisualClip, { type: 'generator' }>,
    target: RenderTarget,
    s: FrameState,
    opacity: number,
    m: Mat2D,
  ): boolean {
    const def = this.registry.get(clip.generatorId)
    if (def?.kind !== 'generator') return false
    const local = s.time - clip.start
    const params = resolveParams(def.params, clip.params, local, s.time, s.audio)
    if (def.fragmentShader) {
      const program = this.pluginProgram(gpu, def)
      if (!program) return false
      const gl = this.gl
      const g = gpu.pool.acquire()
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo)
      gl.disable(gl.BLEND)
      gl.useProgram(program.program)
      this.setCommonUniforms(program, local, s)
      this.setParamUniforms(program, def.params, params)
      this.bindImageParams(gpu, program, def.params, params, s)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      // Render targets store the top row at v = 1, the reverse of DOM sources.
      this.drawQuad(gpu, target, m, { texture: g.texture, flipY: true }, opacity, s)
      gpu.pool.release(g)
      return true
    }
    if (def.draw2d) {
      let canvas = this.canvases2d.get(clip.id)
      if (!canvas || canvas.width !== s.width || canvas.height !== s.height) {
        canvas = new OffscreenCanvas(s.width, s.height)
        this.canvases2d.set(clip.id, canvas)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      ctx.reset()
      const frame: EffectFrameContext = {
        time: s.time,
        localTime: local,
        width: s.width,
        height: s.height,
        params,
        audio: s.audioFrame,
      }
      def.draw2d(ctx, frame)
      const texture = this.texture(gpu, `gen2d:${clip.id}`, canvas, undefined)
      this.drawQuad(gpu, target, m, { texture, flipY: false }, opacity, s)
      return true
    }
    return false
  }

  // -------------------------------------------------------------------------------------------------------------
  // GL helpers

  private clear(target: RenderTarget, [r, g, b, a]: Rgba): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.clearColor(r * a, g * a, b * a, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  private drawQuad(
    gpu: GpuState,
    target: RenderTarget,
    m: Mat2D,
    content: QuadContent,
    opacity: number,
    s: FrameState,
  ): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const p = 'texture' in content ? gpu.programs.layerTexture : gpu.programs.layerSolid
    gl.useProgram(p.program)
    gl.uniformMatrix3fv(p.uniform('u_m'), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1])
    gl.uniform2f(p.uniform('u_canvas'), s.width, s.height)
    gl.uniform4f(p.uniform('u_crop'), 0, 0, 1, 1)
    gl.uniform1f(p.uniform('u_opacity'), opacity)
    if ('texture' in content) {
      this.bindTexture(p, 'u_tex', 0, content.texture)
      gl.uniform1i(p.uniform('u_flipY'), content.flipY ? 1 : 0)
    } else {
      gl.uniform4f(p.uniform('u_color'), ...content.color)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private fullscreen(p: Program, textures: [string, WebGLTexture][]): void {
    const gl = this.gl
    gl.useProgram(p.program)
    textures.forEach(([name, texture], unit) => this.bindTexture(p, name, unit, texture))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private bindTexture(p: Program, name: string, unit: number, texture: WebGLTexture): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(p.uniform(name), unit)
  }

  /** A texture per key; re-uploads when `version` changes, or every call when `version` is undefined. */
  private texture(gpu: GpuState, key: string, source: TexImageSource, version: unknown): WebGLTexture {
    let entry = gpu.textures.get(key)
    const upload = !entry || version === undefined || entry.version !== version
    if (upload) this.gl.activeTexture(this.gl.TEXTURE0 + SCRATCH_UNIT)
    if (!entry) {
      entry = { texture: createTexture(this.gl), version: undefined, lastUsed: 0 }
      gpu.textures.set(key, entry)
    }
    entry.lastUsed = this.frameIndex
    if (upload) {
      uploadSource(this.gl, entry.texture, source)
      entry.version = version
    }
    return entry.texture
  }

  private pluginProgram(gpu: GpuState, def: PluginDefinition): Program | null {
    if (gpu.plugins.has(def)) return gpu.plugins.get(def) ?? null
    let program: Program | null = null
    try {
      if (def.kind === 'effect')
        program = createProgram(
          this.gl,
          FULLSCREEN_VS,
          effectShader(def.params, def.fragmentShader, finalInputs(def)),
        )
      else if (def.kind === 'transition')
        program = createProgram(this.gl, FULLSCREEN_VS, transitionShader(def.params, def.fragmentShader))
      else if (def.kind === 'generator' && def.fragmentShader)
        program = createProgram(this.gl, FULLSCREEN_VS, generatorShader(def.params, def.fragmentShader))
    } catch (error) {
      console.error(`Plugin "${def.id}" failed to compile and is skipped`, error)
    }
    gpu.plugins.set(def, program)
    return program
  }

  private passProgram(gpu: GpuState, def: EffectDefinition, pass: EffectPass): Program | null {
    if (gpu.plugins.has(pass)) return gpu.plugins.get(pass) ?? null
    let program: Program | null = null
    try {
      program = createProgram(
        this.gl,
        FULLSCREEN_VS,
        effectShader(def.params, pass.fragmentShader, pass.inputs ?? []),
      )
    } catch (error) {
      console.error(`Plugin "${def.id}" pass "${pass.id}" failed to compile and is skipped`, error)
    }
    gpu.plugins.set(pass, program)
    return program
  }

  private setCommonUniforms(p: Program, localTime: Seconds, s: FrameState): void {
    const gl = this.gl
    const a = s.audioFrame
    gl.uniform2f(p.uniform('u_resolution'), s.width, s.height)
    gl.uniform1f(p.uniform('u_time'), localTime)
    gl.uniform1f(p.uniform('u_loudness'), a.loudness)
    gl.uniform1f(p.uniform('u_beat'), a.beat)
    gl.uniform1f(p.uniform('u_onset'), a.onset)
    gl.uniform1f(p.uniform('u_downbeat'), a.downbeat)
    gl.uniform1fv(p.uniform('u_bands'), s.bands)
    gl.uniform1f(p.uniform('u_bandCount'), Math.min(BAND_UNIFORMS, a.bands.length))
    gl.uniform1f(p.uniform('u_beatIndex'), a.beatIndex)
    gl.uniform1f(p.uniform('u_beatPhase'), a.beatPhase)
    gl.uniform1f(p.uniform('u_barIndex'), a.barIndex)
    gl.uniform1f(p.uniform('u_barPhase'), a.barPhase)
    gl.uniform1f(p.uniform('u_flow'), a.flow)
    const stems = STEM_ORDER.map((name) => a.stems[name])
    const [v, d, b, o] = stems.map((stem) => stem?.loudness ?? 0) as [number, number, number, number]
    const [vo, dO, bo, oo] = stems.map((stem) => stem?.onset ?? 0) as [number, number, number, number]
    gl.uniform4f(p.uniform('u_stems'), v, d, b, o)
    gl.uniform4f(p.uniform('u_stemOnsets'), vo, dO, bo, oo)
    gl.uniform1f(p.uniform('u_hasStems'), stems.some(Boolean) ? 1 : 0)
  }

  /** Binds image params to texture units from FIRST_IMAGE_PARAM_UNIT; an unset or missing image is transparent. */
  private bindImageParams(
    gpu: GpuState,
    p: Program,
    specs: readonly ParamSpec[],
    params: ResolvedParams,
    s: FrameState,
  ) {
    const gl = this.gl
    let unit = FIRST_IMAGE_PARAM_UNIT
    for (const spec of specs) {
      if (spec.type !== 'image') continue
      const ref = params[spec.key]
      const frame = typeof ref === 'string' && ref ? s.sources.get(imageParamKey(ref)) : undefined
      let texture = gpu.transparent
      if (frame && frame.width > 0 && typeof ref === 'string') {
        const key = s.project.assets[ref] ? `image:${ref}` : `url:${ref}`
        texture = this.texture(gpu, key, frame.source, frame.source)
      }
      this.bindTexture(p, `u_${spec.key}`, unit++, texture)
      const size = texture === gpu.transparent || !frame ? [0, 0] : [frame.width, frame.height]
      gl.uniform2f(p.uniform(`u_${spec.key}Size`), size[0] as number, size[1] as number)
    }
  }

  private setFrameUniforms(p: Program, values: Readonly<Record<string, EffectUniformValue>>): void {
    const gl = this.gl
    for (const key in values) {
      const loc = p.uniform(`u_${key}`)
      const v = values[key]
      if (!loc || v === undefined) continue
      if (typeof v === 'number') gl.uniform1f(loc, v)
      else if (v.length === 2) gl.uniform2f(loc, v[0] ?? 0, v[1] ?? 0)
      else if (v.length === 3) gl.uniform3f(loc, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)
      else if (v.length === 4) gl.uniform4f(loc, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0)
    }
  }

  private setParamUniforms(p: Program, specs: readonly ParamSpec[], params: ResolvedParams): void {
    const gl = this.gl
    for (const spec of specs) {
      const loc = p.uniform(`u_${spec.key}`)
      if (!loc) continue
      const v = params[spec.key]
      switch (spec.type) {
        case 'number':
          gl.uniform1f(loc, typeof v === 'number' ? v : spec.default)
          break
        case 'boolean':
          gl.uniform1f(loc, v === true ? 1 : 0)
          break
        case 'color':
          gl.uniform4f(loc, ...parseColor(typeof v === 'string' ? v : spec.default))
          break
        case 'select':
          gl.uniform1f(
            loc,
            Math.max(
              0,
              spec.options.findIndex((o) => o.value === v),
            ),
          )
          break
        case 'image':
          // Bound as a texture by bindImageParams.
          break
      }
    }
  }

  private sweep(gpu: GpuState, project: Project): void {
    if (this.frameIndex % 60 !== 0) return
    for (const [key, entry] of gpu.textures) {
      if (this.frameIndex - entry.lastUsed > TEXTURE_IDLE_FRAMES) {
        this.gl.deleteTexture(entry.texture)
        gpu.textures.delete(key)
      }
    }
    const ids = new Set(Object.keys(project.clips))
    this.text.retain(ids)
    for (const id of this.canvases2d.keys()) if (!ids.has(id)) this.canvases2d.delete(id)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gpu = this.gpu
    this.gpu = null
    if (this.fence) this.gl.deleteSync(this.fence)
    this.fence = null
    if (gpu) {
      gpu.pool.dispose()
      for (const entry of gpu.textures.values()) this.gl.deleteTexture(entry.texture)
      this.gl.deleteTexture(gpu.transparent)
      for (const p of Object.values(gpu.programs)) this.gl.deleteProgram(p.program)
    }
    this.text.dispose()
    this.canvases2d.clear()
    for (const image of this.urlImages.values())
      void image.then((frame) => (frame?.source as ImageBitmap | undefined)?.close())
    this.urlImages.clear()
  }
}
