/**
 * Preview scenes for library items (plugins, looks and text styles): the same small projects drive the generated
 * thumbnails (tests/tools/thumbnails.spec.ts) and can drive live previews in the UI: render `time` for a still, or
 * loop `loop` with any compositor. Everything here is deterministic.
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginRegistry } from '../engine/types.ts'
import {
  createAudioClip,
  createImageClip,
  createProject,
  createTextClip,
  createTrack,
  settingsForAspect,
} from '../model/factory.ts'
import type { AudioAnalysis, Id, Project, Seconds, TextClip, TextStyle } from '../model/types.ts'
import { ProjectEditor } from '../model/editor.ts'
import { createEffectInstance, createGeneratorClip, createTransition } from './library.ts'
import { applyLookCommands, ORIGINAL_LOOK, type LookRegistry } from './looks.ts'
import { textStyle, textStyleCommands } from './typography/styles.ts'

/** Song asset id used by preview projects; the analysis is synthetic, so no audio file is needed. */
export const PREVIEW_SONG_ID = 'preview-song'
const PREVIEW_DURATION = 8
const BPM = 120

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * A sunset city with a neon sign: warm and cool tones, highlights and fine detail for effects to work on. With
 * `mode: 'depth'` it draws the matching depth map instead (red channel, 0 far .. 1 near), for depth-based effects.
 */
export function drawSampleScene(ctx: Ctx2D, w: number, h: number, mode: 'color' | 'depth' = 'color'): void {
  const depth = mode === 'depth'
  const gray = (v: number) => {
    const c = Math.round(v * 255)
    return `rgb(${c},${c},${c})`
  }
  // Both modes draw the same shapes from the same random sequence, so the depth map lines up with the picture.
  const random = rng(7)
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.72)
  sky.addColorStop(0, '#1a1440')
  sky.addColorStop(0.45, '#6b2d6b')
  sky.addColorStop(0.8, '#ff7a45')
  sky.addColorStop(1, '#ffc46b')
  ctx.fillStyle = depth ? gray(0) : sky
  ctx.fillRect(0, 0, w, h)
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.3 + random() * 0.5})`
    const sx = random() * w
    const sy = random() * h * 0.35
    if (!depth) ctx.fillRect(sx, sy, 1.2, 1.2)
  }
  const sunX = w * 0.66
  const sunY = h * 0.5
  if (!depth) {
    const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.45)
    glow.addColorStop(0, 'rgba(255,220,150,0.65)')
    glow.addColorStop(1, 'rgba(255,120,80,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, w, h)
    const sun = ctx.createLinearGradient(0, sunY - h * 0.14, 0, sunY + h * 0.14)
    sun.addColorStop(0, '#fff1c1')
    sun.addColorStop(1, '#ff9a4a')
    ctx.fillStyle = sun
    ctx.beginPath()
    ctx.arc(sunX, sunY, h * 0.14, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = depth ? gray(0.25) : '#3a1d4f'
  ctx.beginPath()
  ctx.moveTo(0, h * 0.7)
  for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, h * (0.6 + 0.06 * Math.sin(x * 0.02) + random() * 0.03))
  ctx.lineTo(w, h * 0.72)
  ctx.lineTo(0, h * 0.72)
  ctx.fill()
  let x = -5
  while (x < w) {
    const bw = w * (0.03 + random() * 0.05)
    const bh = h * (0.08 + random() * 0.2)
    const top = h * 0.74 - bh
    ctx.fillStyle = depth ? gray(0.5) : '#140d26'
    ctx.fillRect(x, top, bw, bh)
    ctx.fillStyle = '#ffd27a'
    for (let wy = top + 4; wy < h * 0.72; wy += 7)
      for (let wx = x + 3; wx < x + bw - 3; wx += 5) if (random() < 0.3 && !depth) ctx.fillRect(wx, wy, 2, 3)
    x += bw + 1
  }
  const water = ctx.createLinearGradient(0, h * 0.74, 0, h)
  water.addColorStop(0, depth ? gray(0.55) : '#2a1840')
  water.addColorStop(1, depth ? gray(1) : '#0b0716')
  ctx.fillStyle = water
  ctx.fillRect(0, h * 0.74, w, h * 0.26)
  for (let y = h * 0.76; y < h; y += 4) {
    const spread = (y - h * 0.74) * 0.9 + 6
    ctx.fillStyle = `rgba(255,180,100,${0.55 - (y - h * 0.74) / h})`
    const rx = sunX - spread * (0.6 + random() * 0.4)
    const rw = spread * 1.2 * (0.6 + random() * 0.4)
    if (!depth) ctx.fillRect(rx, y, rw, 1.5)
  }
  ctx.save()
  ctx.shadowColor = depth ? 'transparent' : '#ff3df2'
  ctx.shadowBlur = depth ? 0 : h * 0.04
  ctx.strokeStyle = depth ? gray(0.8) : '#ff6af5'
  ctx.lineWidth = Math.max(2, h * 0.012)
  ctx.beginPath()
  ctx.roundRect(w * 0.12, h * 0.2, w * 0.24, h * 0.2, h * 0.03)
  ctx.stroke()
  ctx.shadowColor = depth ? 'transparent' : '#3df2ff'
  ctx.fillStyle = depth ? gray(0.8) : '#b8fbff'
  ctx.font = `800 ${Math.round(h * 0.13)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('MV', w * 0.24, h * 0.305)
  ctx.restore()
}

/** Encodes the sample scene (or its depth map) as a PNG, ready to store as an image asset. */
export async function sampleSceneBlob(
  width = 640,
  height = 360,
  mode: 'color' | 'depth' = 'color',
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is not available')
  drawSampleScene(ctx, width, height, mode)
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Synthetic analysis of a 120 BPM song with kicks on the beat, so reactive items move in previews. */
export function sampleAnalysis(
  assetId: Id = PREVIEW_SONG_ID,
  duration: Seconds = PREVIEW_DURATION,
): AudioAnalysis {
  const rate = 50
  const period = 60 / BPM
  const n = Math.ceil(duration * rate) + 1
  const loudness: number[] = []
  const bands: number[][] = []
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const kick = Math.exp(-(t % period) * 9)
    const hat = Math.exp(-((t + period / 2) % period) * 18)
    loudness.push(0.5 + 0.4 * kick)
    bands.push(
      Array.from({ length: 7 }, (_, b) => {
        const base = 0.75 - b * 0.07 + 0.08 * Math.sin(t * (1.3 + b * 0.7) + b)
        const hit = b < 2 ? kick : b > 4 ? hat : 0.5 * (kick + hat)
        return Math.min(1, Math.max(0, base * (0.55 + 0.45 * hit)))
      }),
    )
  }
  const beats: number[] = []
  for (let t = 0; t <= duration; t += period) beats.push(Number(t.toFixed(4)))
  return {
    assetId,
    version: 'preview',
    tempo: { bpm: BPM, confidence: 1 },
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    features: {
      rate,
      loudness,
      bands,
      bandEdgesHz: [20, 60, 250, 500, 2000, 4000, 6000, 20000],
      onsets: beats.flatMap((b) => [b, b + period / 2]),
    },
  }
}

/** A blank 16:9 project with the synthetic song on its audio track. */
export function previewBase(name = 'Preview'): Project {
  const p = createProject({ name })
  p.settings = { ...settingsForAspect('16:9'), backgroundColor: '#05040a' }
  p.songAssetId = PREVIEW_SONG_ID
  const audioTrack = p.tracks.find((t) => t.kind === 'audio')
  if (!audioTrack) throw new Error('Project has no audio track')
  const song = createAudioClip({
    trackId: audioTrack.id,
    assetId: PREVIEW_SONG_ID,
    start: 0,
    duration: PREVIEW_DURATION,
  })
  p.clips[song.id] = song
  p.analysis.audio[PREVIEW_SONG_ID] = sampleAnalysis()
  p.duration = PREVIEW_DURATION
  return p
}

export interface PluginPreview {
  project: Project
  /** A representative moment for a still thumbnail: mid-entrance, just after a beat, or mid-transition. */
  time: Seconds
  /** A time range worth looping for a live preview (hover or picker). */
  loop: [Seconds, Seconds]
}

export interface PreviewOptions {
  /** Image asset shown under effects, transitions, text and looks (the sample scene, or the user's own frame). */
  image?: Project['assets'][string]
  /** Depth map of `image` (red channel, 0 far .. 1 near), bound to effects with a `depth` image param. */
  depth?: Project['assets'][string]
  registry?: PluginRegistry
}

/** Time just after the downbeat at 2 s, where beat-driven items are near their peak. */
const ON_BEAT = 2.04
const TEXT_START = 1
const TEXT_DURATION = 4
const PREVIEW_TEXT = 'Feel the night'

function addScene(
  p: Project,
  image: PreviewOptions['image'],
  start: Seconds,
  duration: Seconds,
  what: string,
) {
  if (!image) throw new Error(`Previewing “${what}” needs an image`)
  p.assets[image.id] = image
  const clip = createImageClip({ trackId: p.tracks[0]?.id as Id, assetId: image.id, start, duration })
  p.clips[clip.id] = clip
  return clip
}

/** Puts a text clip on a new top track over the (dimmed) image, if there is one. */
function addPreviewText(
  p: Project,
  image: PreviewOptions['image'],
  text: string,
  duration = TEXT_DURATION,
  fontSize = 150,
) {
  const top = createTrack('visual', 'Text')
  p.tracks.unshift(top)
  if (image) {
    const bg = addScene(p, image, 0, PREVIEW_DURATION, 'text')
    bg.adjustments = { exposure: { value: -0.35 }, saturation: { value: -0.3 } }
  }
  const clip = createTextClip({ trackId: top.id, text, start: TEXT_START, duration })
  clip.style = { ...clip.style, fontSize }
  p.clips[clip.id] = clip
  return clip
}

/** The style scaled as a whole (size, outline, shadow and box), like zooming in on the text. */
function zoomStyle(style: TextStyle, k: number): TextStyle {
  return {
    ...style,
    fontSize: style.fontSize * k,
    ...(style.stroke ? { stroke: { ...style.stroke, width: style.stroke.width * k } } : {}),
    ...(style.shadow
      ? {
          shadow: {
            ...style.shadow,
            blur: style.shadow.blur * k,
            offsetX: style.shadow.offsetX * k,
            offsetY: style.shadow.offsetY * k,
          },
        }
      : {}),
    ...(style.background
      ? {
          background: {
            ...style.background,
            padding: style.background.padding * k,
            radius: style.background.radius * k,
          },
        }
      : {}),
  }
}

/**
 * A preview project for a plugin. Effects and transitions need `image`: an image asset to show (the sample scene, or
 * the user's own frame) that is added to the project. A `progress` param (0..1, like the 3D camera move's) is
 * keyframed across the first 4 seconds so the move plays.
 */
export function pluginPreview(pluginId: string, options: PreviewOptions = {}): PluginPreview {
  const registry = options.registry ?? pluginRegistry
  const def = registry.get(pluginId)
  if (!def) throw new Error(`Unknown plugin “${pluginId}”`)
  const p = previewBase(def.name)
  const trackId = p.tracks[0]?.id as Id
  switch (def.kind) {
    case 'effect': {
      const clip = addScene(p, options.image, 0, PREVIEW_DURATION, pluginId)
      const effect = createEffectInstance(def.id, registry)
      for (const spec of def.params) {
        if (spec.key === 'progress' && spec.type === 'number' && spec.min === 0 && spec.max === 1)
          effect.params.progress = {
            value: 0,
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 4, value: 1, easing: 'linear' },
            ],
          }
        if (spec.type === 'image' && spec.key === 'depth' && options.depth) {
          p.assets[options.depth.id] = options.depth
          effect.params.depth = { value: options.depth.id }
        }
      }
      clip.effects = [effect]
      return { project: p, time: ON_BEAT, loop: [0, 4] }
    }
    case 'transition': {
      addScene(p, options.image, 0, 2, pluginId)
      const next = addScene(p, options.image, 2, PREVIEW_DURATION - 2, pluginId)
      next.transform.scaleX = { value: -1 }
      next.adjustments = { hue: { value: 0.55 }, saturation: { value: 0.2 } }
      const transition = createTransition(def.id, { duration: 1 }, registry)
      next.transitionIn = { ...transition, easing: 'linear' }
      // Early in the transition, so dips and flashes still show the picture.
      return { project: p, time: 2.3, loop: [1.4, 3.6] }
    }
    case 'generator': {
      const clip = createGeneratorClip(
        { trackId, generatorId: def.id, start: 0, duration: PREVIEW_DURATION },
        registry,
      )
      p.clips[clip.id] = clip
      return { project: p, time: ON_BEAT, loop: [0, 4] }
    }
    case 'text-animation': {
      const text = addPreviewText(p, options.image, PREVIEW_TEXT, TEXT_DURATION, 190)
      text.animation = { presetId: def.id, params: {} }
      // Entrances read best mid-way in; emphasis and karaoke presets once the words are up and the beat hits.
      const time = def.category === 'Entrance' ? TEXT_START + 0.3 : ON_BEAT
      return { project: p, time, loop: [TEXT_START - 0.2, TEXT_START + TEXT_DURATION] }
    }
  }
}

/** A preview project for a look: the image and a line of text, with the look applied (none for ORIGINAL_LOOK). */
export function lookPreview(
  lookId: string,
  options: PreviewOptions & { looks?: LookRegistry } = {},
): PluginPreview {
  const p = previewBase('Look preview')
  addPreviewText(p, options.image, PREVIEW_TEXT)
  const editor = new ProjectEditor(p)
  if (lookId && lookId !== ORIGINAL_LOOK.id) {
    const commands = applyLookCommands(p, lookId, {
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.looks ? { looks: options.looks } : {}),
    })
    editor.dispatch(commands)
  }
  return { project: editor.getProject(), time: 3, loop: [0, 4] }
}

/**
 * A preview project for a text style: its sample text in the style over the dimmed image. Small styles (captions)
 * are zoomed so the sample stays legible in a thumbnail.
 */
export function textStylePreview(styleId: string, options: PreviewOptions = {}): PluginPreview {
  const p = previewBase('Text style preview')
  const text = addPreviewText(p, options.image, textStyle(styleId)?.sample ?? PREVIEW_TEXT, 5)
  const editor = new ProjectEditor(p)
  editor.dispatch(textStyleCommands(p, [text.id], styleId))
  const styled = editor.getProject().clips[text.id] as TextClip
  const zoom = Math.min(2.4, Math.max(1, 130 / styled.style.fontSize))
  editor.dispatch({
    type: 'clip.set',
    clipId: text.id,
    path: ['style'],
    value: zoomStyle(styled.style, zoom),
  })
  return { project: editor.getProject(), time: 4.2, loop: [TEXT_START - 0.2, TEXT_START + 5] }
}
