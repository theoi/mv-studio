/**
 * Preview scenes for library items: the same small projects drive the generated thumbnails and can drive live
 * previews in the UI (render them with any compositor). Everything here is deterministic.
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
import type { AudioAnalysis, Id, Project, Seconds } from '../model/types.ts'
import { createEffectInstance, createGeneratorClip, createTransition } from './library.ts'

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

/** A sunset city with a neon sign: warm and cool tones, highlights and fine detail for effects to work on. */
export function drawSampleScene(ctx: Ctx2D, w: number, h: number): void {
  const random = rng(7)
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.72)
  sky.addColorStop(0, '#1a1440')
  sky.addColorStop(0.45, '#6b2d6b')
  sky.addColorStop(0.8, '#ff7a45')
  sky.addColorStop(1, '#ffc46b')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.3 + random() * 0.5})`
    ctx.fillRect(random() * w, random() * h * 0.35, 1.2, 1.2)
  }
  const sunX = w * 0.66
  const sunY = h * 0.5
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
  ctx.fillStyle = '#3a1d4f'
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
    ctx.fillStyle = '#140d26'
    ctx.fillRect(x, top, bw, bh)
    ctx.fillStyle = '#ffd27a'
    for (let wy = top + 4; wy < h * 0.72; wy += 7)
      for (let wx = x + 3; wx < x + bw - 3; wx += 5) if (random() < 0.3) ctx.fillRect(wx, wy, 2, 3)
    x += bw + 1
  }
  const water = ctx.createLinearGradient(0, h * 0.74, 0, h)
  water.addColorStop(0, '#2a1840')
  water.addColorStop(1, '#0b0716')
  ctx.fillStyle = water
  ctx.fillRect(0, h * 0.74, w, h * 0.26)
  for (let y = h * 0.76; y < h; y += 4) {
    const spread = (y - h * 0.74) * 0.9 + 6
    ctx.fillStyle = `rgba(255,180,100,${0.55 - (y - h * 0.74) / h})`
    ctx.fillRect(sunX - spread * (0.6 + random() * 0.4), y, spread * 1.2 * (0.6 + random() * 0.4), 1.5)
  }
  ctx.save()
  ctx.shadowColor = '#ff3df2'
  ctx.shadowBlur = h * 0.04
  ctx.strokeStyle = '#ff6af5'
  ctx.lineWidth = Math.max(2, h * 0.012)
  ctx.beginPath()
  ctx.roundRect(w * 0.12, h * 0.2, w * 0.24, h * 0.2, h * 0.03)
  ctx.stroke()
  ctx.shadowColor = '#3df2ff'
  ctx.fillStyle = '#b8fbff'
  ctx.font = `800 ${Math.round(h * 0.13)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('MV', w * 0.24, h * 0.305)
  ctx.restore()
}

/** Encodes the sample scene as a PNG, ready to store as an image asset. */
export async function sampleSceneBlob(width = 640, height = 360): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is not available')
  drawSampleScene(ctx, width, height)
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
  /** A representative moment: just after a beat, or mid-transition. */
  time: Seconds
}

/** Time just after the downbeat at 2 s, where beat-driven items are near their peak. */
const ON_BEAT = 2.04

/**
 * A preview project for a plugin. Effects and transitions need `imageAssetId`: an image asset to show (the sample
 * scene, or the user's own frame) that is added to the project.
 */
export function pluginPreview(
  pluginId: string,
  options: { image?: Project['assets'][string]; registry?: PluginRegistry } = {},
): PluginPreview {
  const registry = options.registry ?? pluginRegistry
  const def = registry.get(pluginId)
  if (!def) throw new Error(`Unknown plugin "${pluginId}"`)
  const p = previewBase(def.name)
  const trackId = p.tracks[0]?.id as Id
  const image = options.image
  if (image) p.assets[image.id] = image
  const sceneClip = (start: Seconds, duration: Seconds) => {
    if (!image) throw new Error(`Previewing "${pluginId}" needs an image`)
    const clip = createImageClip({ trackId, assetId: image.id, start, duration })
    p.clips[clip.id] = clip
    return clip
  }
  switch (def.kind) {
    case 'effect': {
      const clip = sceneClip(0, PREVIEW_DURATION)
      clip.effects = [createEffectInstance(def.id, registry)]
      return { project: p, time: ON_BEAT }
    }
    case 'transition': {
      sceneClip(0, 2)
      const next = sceneClip(2, PREVIEW_DURATION - 2)
      next.transform.scaleX = { value: -1 }
      next.adjustments = { hue: { value: 0.55 }, saturation: { value: 0.2 } }
      const transition = createTransition(def.id, { duration: 1 }, registry)
      next.transitionIn = { ...transition, easing: 'linear' }
      return { project: p, time: 2.45 }
    }
    case 'generator': {
      const clip = createGeneratorClip(
        { trackId, generatorId: def.id, start: 0, duration: PREVIEW_DURATION },
        registry,
      )
      p.clips[clip.id] = clip
      return { project: p, time: ON_BEAT }
    }
    case 'text-animation': {
      const top = createTrack('visual', 'Text')
      p.tracks.unshift(top)
      if (image) {
        const bg = sceneClip(0, PREVIEW_DURATION)
        bg.adjustments = { exposure: { value: -0.35 }, saturation: { value: -0.3 } }
      }
      const text = createTextClip({ trackId: top.id, text: 'Feel the night', start: 1, duration: 4 })
      text.style = { ...text.style, fontSize: 150 }
      text.animation = { presetId: def.id, params: {} }
      p.clips[text.id] = text
      return { project: p, time: 1.9 }
    }
  }
}
