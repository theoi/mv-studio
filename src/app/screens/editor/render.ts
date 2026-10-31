import { sceneLayers, type SceneId } from '../../mock/art.ts'
import { song } from '../../mock/song.ts'
import type { LyricLine, Project, Transform } from '../../../model/index.ts'
import { clipsAt } from '../../../model/index.ts'
import { sceneOf } from '../../mock/demoProject.ts'
import {
  energyAt,
  lyricAt,
  sectionAt,
  sectionKind,
  songAnalysis,
  bpmOf,
  type SectionKind,
} from '../../state/project.ts'

/*
 * Stand-in for the engine compositor in the design preview: a Canvas 2D sketch of a frame. The real preview calls
 * src/engine's Compositor.render(project, time); this only needs to look right, not match export.
 */

export interface FrameInput {
  t: number
  scene?: SceneId
  clipProgress: number
  transform?: { x: number; y: number; scale: number; rotation: number; opacity: number; reactive: boolean }
  overlay?: {
    kind: 'spectrum' | 'particles' | 'title'
    progress: number
    id: string
    text?: string
    subtitle?: string
  }
  lyric?: LyricLine
  energy: number
  beatInterval: number
  sectionKind: SectionKind
  behindSubject: boolean
  selectedClipId?: string
  selectedLyricId?: string
  showSelection: boolean
}

const KARAOKE = '#ffd27a'

function easeOut(x: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)
}

function transformOf(t: Transform, opacity: number) {
  return {
    x: t.x.value,
    y: t.y.value,
    scale: t.scaleX.value,
    rotation: t.rotation.value,
    opacity,
    reactive: !!t.scaleX.modulation?.length,
  }
}

export function describeFrame(
  p: Project,
  t: number,
  ui: { behindSubject: boolean; selectedClipId?: string; selectedLyricId?: string; showSelection: boolean },
): FrameInput {
  const active = clipsAt(p, t)
  const hidden = new Set(p.tracks.filter((tr) => tr.hidden).map((tr) => tr.id))
  const media = active
    .filter((c) => !hidden.has(c.trackId) && (c.type === 'video' || c.type === 'image'))
    .sort(
      (a, b) => p.tracks.findIndex((x) => x.id === b.trackId) - p.tracks.findIndex((x) => x.id === a.trackId),
    )
    .pop()
  const overlayClip = active.find(
    (c) => !hidden.has(c.trackId) && (c.type === 'generator' || (c.type === 'text' && !c.lyricLineId)),
  )
  const sec = sectionAt(p, t)
  const bpm = bpmOf(p) ?? song.bpm
  let overlay: FrameInput['overlay']
  if (overlayClip) {
    const progress = (t - overlayClip.start) / overlayClip.duration
    if (overlayClip.type === 'generator')
      overlay = {
        kind: overlayClip.generatorId.includes('particles') ? 'particles' : 'spectrum',
        progress,
        id: overlayClip.id,
      }
    else if (overlayClip.type === 'text')
      overlay = {
        kind: 'title',
        progress,
        id: overlayClip.id,
        text:
          overlayClip.style.textTransform === 'uppercase' ? overlayClip.text.toUpperCase() : overlayClip.text,
        subtitle: overlayClip.id === 'o-title' ? song.artist : undefined,
      }
  }
  const lyricsHidden = p.tracks.some(
    (tr) =>
      tr.hidden &&
      Object.values(p.clips).some((c) => c.trackId === tr.id && c.type === 'text' && c.lyricLineId),
  )
  return {
    t,
    scene: media && 'assetId' in media ? sceneOf(p.assets[media.assetId]) : undefined,
    clipProgress: media ? (t - media.start) / media.duration : 0,
    transform: media && 'transform' in media ? transformOf(media.transform, media.opacity.value) : undefined,
    overlay,
    lyric: lyricsHidden ? undefined : lyricAt(p, t),
    energy: energyAt(songAnalysis(p), t),
    beatInterval: 60 / bpm,
    sectionKind: sec ? sectionKind(sec) : 'verse',
    behindSubject: ui.behindSubject,
    selectedClipId: ui.selectedClipId,
    selectedLyricId: ui.selectedLyricId,
    showSelection: ui.showSelection,
  }
}

function selectionBox(ctx: CanvasRenderingContext2D, x: number, y: number, bw: number, bh: number) {
  ctx.save()
  ctx.strokeStyle = '#8d81fa'
  ctx.lineWidth = 1.5
  ctx.strokeRect(x, y, bw, bh)
  ctx.fillStyle = '#ffffff'
  const s = 7
  for (const [hx, hy] of [
    [x, y],
    [x + bw, y],
    [x, y + bh],
    [x + bw, y + bh],
  ] as const) {
    ctx.fillRect(hx - s / 2, hy - s / 2, s, s)
    ctx.strokeRect(hx - s / 2, hy - s / 2, s, s)
  }
  ctx.restore()
}

function drawLyric(
  ctx: CanvasRenderingContext2D,
  line: LyricLine,
  t: number,
  w: number,
  y: number,
  size: number,
  selected: boolean,
) {
  ctx.font = `750 ${size}px "Inter Variable", Inter, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const space = size * 0.28
  const words = line.words.length
    ? line.words
    : [{ text: line.text, start: line.start ?? 0, end: line.end ?? 0 }]
  const widths = words.map((wd) => ctx.measureText(wd.text).width)
  const total = widths.reduce((a, b) => a + b, 0) + space * (widths.length - 1)
  const maxW = w * 0.86
  const scale = total > maxW ? maxW / total : 1
  ctx.save()
  ctx.translate(w / 2, y)
  ctx.scale(scale, scale)
  let x = -total / 2
  const lineStart = line.start ?? words[0]?.start ?? 0
  words.forEach((wd, i) => {
    const ww = widths[i] ?? 0
    const appear = easeOut((t - (lineStart - 0.25 + i * 0.04)) / 0.3)
    const sung = Math.min(1, Math.max(0, (t - wd.start) / Math.max(0.01, wd.end - wd.start)))
    const dy = (1 - appear) * size * 0.35
    ctx.globalAlpha = 0.25 + appear * 0.75
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = size * 0.4
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText(wd.text, x, dy)
    ctx.shadowBlur = 0
    if (sung > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x - 2, -size, ww * sung + 2, size * 2)
      ctx.clip()
      ctx.fillStyle = t > wd.end ? '#ffffff' : KARAOKE
      ctx.fillText(wd.text, x, dy)
      ctx.restore()
    }
    x += ww + space
  })
  ctx.restore()
  ctx.globalAlpha = 1
  if (selected) {
    const bw = total * scale + size * 0.8
    const bh = size * 1.6
    selectionBox(ctx, w / 2 - bw / 2, y - bh / 2, bw, bh)
  }
}

export function renderFrame(ctx: CanvasRenderingContext2D, w: number, h: number, f: FrameInput) {
  const { t } = f
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  const phase = (t % f.beatInterval) / f.beatInterval
  const pulse = Math.exp(-phase * 6)
  let fg: HTMLCanvasElement | null = null
  const drawLayer = (img: HTMLCanvasElement) => {
    const tr = f.transform
    const kick = f.sectionKind === 'chorus' ? pulse * 0.012 : 0
    const react = tr?.reactive ? pulse * f.energy * 0.06 : 0
    const s = Math.max(w / 1280, h / 720) * (1.03 + f.clipProgress * 0.04 + kick + react) * (tr?.scale ?? 1)
    ctx.save()
    ctx.globalAlpha = tr?.opacity ?? 1
    ctx.translate(w * (tr?.x ?? 0.5), h * (tr?.y ?? 0.5))
    ctx.rotate(((tr?.rotation ?? 0) * Math.PI) / 180)
    ctx.drawImage(img, (-1280 * s) / 2, (-720 * s) / 2, 1280 * s, 720 * s)
    ctx.restore()
  }

  if (f.scene) {
    const layers = sceneLayers(f.scene)
    drawLayer(layers.bg)
    fg = layers.fg
    if (fg && !f.behindSubject) {
      drawLayer(fg)
      fg = null
    }
  }

  if (f.sectionKind === 'chorus' && phase < 0.25 && Math.floor(t / f.beatInterval) % 4 === 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.07 * pulse})`
    ctx.fillRect(0, 0, w, h)
  }

  const vg = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75,
  )
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, w, h)

  const e = f.energy
  if (f.overlay?.kind === 'spectrum') {
    const n = 56
    const gap = w * 0.004
    const bw = (w * 0.8 - gap * (n - 1)) / n
    const baseY = h * 0.95
    for (let i = 0; i < n; i++) {
      const v0 = Math.abs(Math.sin(i * 0.37 + t * 3.1)) * Math.abs(Math.cos(i * 0.11 - t * 1.7))
      const low = i < 10 ? pulse * 0.6 : 0
      const v = Math.min(1, e * (0.18 + 0.62 * v0) + low * e)
      const bh = v * h * 0.14
      const g = ctx.createLinearGradient(0, baseY - bh, 0, baseY)
      g.addColorStop(0, 'rgba(255,255,255,0.95)')
      g.addColorStop(1, 'rgba(255,255,255,0.35)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.roundRect(w * 0.1 + i * (bw + gap), baseY - bh, bw, bh, [bw / 2, bw / 2, 0, 0])
      ctx.fill()
    }
  }

  if (f.overlay?.kind === 'particles') {
    for (let i = 0; i < 90; i++) {
      const sx = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1)
      const sy = Math.abs((Math.sin(i * 78.233) * 12345.6789) % 1)
      const x = (sx * w + t * 12 * (1 + (i % 3))) % w
      const y = (((sy * h - t * 18 * (1 + (i % 2))) % h) + h) % h
      const r = 1 + (i % 4) * 0.6 + pulse * e * 2
      ctx.fillStyle = `rgba(255,255,255,${0.35 + (i % 5) * 0.1})`
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  if (f.overlay?.kind === 'title') {
    const p = f.overlay.progress
    const a = Math.min(easeOut(p * 6), easeOut((1 - p) * 5))
    ctx.save()
    ctx.globalAlpha = a
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'
    const size = h * 0.11
    ctx.font = `800 ${size}px "Inter Variable", Inter, sans-serif`
    ctx.letterSpacing = `${size * 0.22}px`
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = size * 0.5
    const label = f.overlay.text ?? ''
    if (!f.overlay.subtitle) {
      ctx.font = `700 ${size * 0.7}px "Inter Variable", Inter, sans-serif`
      ctx.letterSpacing = '0px'
      ctx.fillText(label, w / 2, h * 0.46 - (1 - a) * 12)
    } else {
      ctx.fillText(label, w / 2 + size * 0.11, h * 0.46 - (1 - a) * 12)
      ctx.font = `500 ${size * 0.26}px "Inter Variable", Inter, sans-serif`
      ctx.letterSpacing = `${size * 0.08}px`
      ctx.globalAlpha = a * 0.8
      ctx.fillText(f.overlay.subtitle.toUpperCase(), w / 2, h * 0.46 + size * 0.75)
    }
    ctx.restore()
    if (f.showSelection && f.selectedClipId === f.overlay.id)
      selectionBox(ctx, w * 0.2, h * 0.36, w * 0.6, h * 0.22)
  }

  if (f.lyric) {
    const behind = !!fg
    const size = behind ? h * 0.13 : h * 0.075
    const y = behind ? h * 0.36 : f.overlay?.kind === 'spectrum' ? h * 0.7 : h * 0.8
    drawLyric(ctx, f.lyric, t, w, y, size, f.showSelection && f.selectedLyricId === f.lyric.id)
  }

  if (fg) drawLayer(fg)

  if (
    f.showSelection &&
    f.selectedClipId &&
    f.selectedClipId === f.overlay?.id &&
    f.overlay.kind !== 'title'
  ) {
    ctx.save()
    ctx.strokeStyle = 'rgba(141,129,250,0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, w - 2, h - 2)
    ctx.restore()
  }
}
