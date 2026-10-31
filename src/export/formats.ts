/**
 * Output formats: the project rendered at another aspect ratio, as an ordinary project. The export dialog previews
 * exactly what an output contains, and export renders it like any other project.
 *
 * - Footage that fills the frame is reframed. Its transform follows the subject (src/vision reframe plans) as
 *   keyframes. Clips that already move (Ken Burns) keep their motion, because the crop is taken from what they show.
 * - Text keeps its size relative to the frame's shorter side, rewraps to the format and moves into the format's safe
 *   area, clear of the buttons and captions of vertical feeds. Text that would fill too much of the frame shrinks.
 * - Other layers (picture-in-picture, logos, visualizer strips) keep their size relative to the shorter side and
 *   move into the safe area.
 *
 * Per-clip framing overrides (stored with the project, see ./settings.ts) compose with the automatic framing.
 */
import { evaluate } from '../engine/animation.ts'
import { fitSize, layerMatrix, type Mat2D } from '../engine/layout.ts'
import { cssFont, fontPxFor, layoutText } from '../engine/text.ts'
import { ASPECT_PRESETS } from '../model/factory.ts'
import type {
  Animatable,
  AspectPreset,
  Asset,
  Easing,
  Id,
  ImageClip,
  Keyframe,
  Project,
  Seconds,
  TextClip,
  VideoClip,
  VisualClip,
} from '../model/types.ts'
import { readSubjectTrack, reframePlanFor } from '../vision/analysisData.ts'
import { cropAt } from '../vision/reframe/planner.ts'
import type { ReframePlan } from '../vision/types.ts'

export interface SafeArea {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Insets, as fractions of the frame, that text and overlays stay inside. Vertical feeds (Reels, TikTok, Shorts) put
 * their buttons on the right and captions at the bottom.
 */
export const SAFE_AREAS: Record<AspectPreset, SafeArea> = {
  '16:9': { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
  '9:16': { top: 0.12, right: 0.12, bottom: 0.2, left: 0.06 },
  '1:1': { top: 0.06, right: 0.06, bottom: 0.06, left: 0.06 },
  '4:5': { top: 0.06, right: 0.06, bottom: 0.1, left: 0.06 },
}

/** 'auto' follows the subject, 'fill' crops the centre, 'fit' shows the whole picture with bars. */
export type ReframeMode = 'auto' | 'fill' | 'fit'

export interface FramingOverride {
  /** Footage only. */
  mode?: ReframeMode
  /** Moves the framing: footage in crop widths and heights, text and other layers in frame widths and heights. */
  offsetX?: number
  offsetY?: number
  /** Footage: >= 1 crops tighter. Text and other layers: a size multiplier. */
  zoom?: number
}

export interface FormatOptions {
  /** How footage fills the frame (default 'auto'). */
  reframe?: ReframeMode
  /** By clip id. */
  overrides?: Readonly<Record<Id, FramingOverride>>
  /** Advance width of text in a CSS font; defaults to a canvas measurement. */
  measure?: (text: string, font: string) => number
  /** Keyframes per second sampled from reframe plans (default 10). */
  sampleRate?: number
}

export type ClipFraming = 'reframed' | 'centred' | 'fit' | 'text' | 'moved' | 'unchanged'

export interface FormatConversion {
  project: Project
  /** What happened to each visual clip. 'centred': auto framing had no subject data and cropped the centre. */
  clips: Record<Id, ClipFraming>
  /** Footage assets that have no subject analysis yet; analysing them improves auto framing. */
  unanalysed: Id[]
}

const EPS = 1e-6
const DEFAULT_SAMPLE_RATE = 10
/** Before a cut, the transform holds its value until this long before the cut keyframe. */
const CUT_GAP: Seconds = 1 / 240
/** Text may take at most this share of the safe area's height before it shrinks. */
const MAX_TEXT_SHARE = 0.5
/** Shrunk text stays at least this tall, as a fraction of the shorter side (about 32 px at 1080). */
const MIN_TEXT_PX = 0.03
const POSITION_TOLERANCE = 0.0015
const SCALE_TOLERANCE = 0.002

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Canvas size of a format with the same shorter side as the project's canvas. */
export function formatSize(project: Project, aspect: AspectPreset): { width: number; height: number } {
  const preset = ASPECT_PRESETS[aspect]
  const short = Math.min(project.settings.width, project.settings.height)
  const scale = short / Math.min(preset.width, preset.height)
  return { width: even(preset.width * scale), height: even(preset.height * scale) }
}

interface Frame {
  width: number
  height: number
  short: number
  safe: SafeArea
}

function frame(width: number, height: number, aspect: AspectPreset): Frame {
  return { width, height, short: Math.min(width, height), safe: SAFE_AREAS[aspect] }
}

let measureContext: OffscreenCanvasRenderingContext2D | null | undefined

function defaultMeasure(text: string, font: string): number {
  if (measureContext === undefined)
    measureContext = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : null
  if (!measureContext) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16)
    return text.length * px * 0.55
  }
  measureContext.font = font
  return measureContext.measureText(text).width
}

// ---------------------------------------------------------------------------------------------------------------
// Animatable helpers

function mapAnimatable(anim: Animatable, f: (v: number) => number): Animatable {
  return {
    ...anim,
    value: f(anim.value),
    ...(anim.keyframes ? { keyframes: anim.keyframes.map((k) => ({ ...k, value: f(k.value) })) } : {}),
  }
}

function keyframeTimes(...anims: Animatable[]): number[] {
  return anims.flatMap((a) => (a.keyframes ?? []).map((k) => k.time))
}

interface Sample {
  t: number
  v: number[]
  /** Kept through simplification; 'hold' when the value jumps at the next sample (a cut). */
  keep?: boolean
  easing?: Easing
}

/** Ramer-Douglas-Peucker over several channels, each with its own tolerance; kept samples stay. */
function simplify(samples: Sample[], tolerance: number[]): Sample[] {
  const keep = samples.map((s, i) => i === 0 || i === samples.length - 1 || s.keep === true)
  const error = (i: number, a: number, b: number) => {
    const sa = samples[a] as Sample
    const sb = samples[b] as Sample
    const s = samples[i] as Sample
    const w = sb.t > sa.t ? (s.t - sa.t) / (sb.t - sa.t) : 0
    let worst = 0
    s.v.forEach((v, c) => {
      const line = (sa.v[c] as number) + ((sb.v[c] as number) - (sa.v[c] as number)) * w
      worst = Math.max(worst, Math.abs(v - line) / (tolerance[c] as number))
    })
    return worst
  }
  const visit = (a: number, b: number) => {
    let worst = 1
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const e = error(i, a, b)
      if (e > worst) {
        worst = e
        index = i
      }
    }
    if (index >= 0) {
      keep[index] = true
      visit(a, index)
      visit(index, b)
    }
  }
  let start = 0
  for (let i = 1; i < samples.length; i++) {
    if (!keep[i]) continue
    // A hold segment is flat by construction; only simplify between linear neighbours.
    if ((samples[start] as Sample).easing !== 'hold') visit(start, i)
    start = i
  }
  return samples.filter((_, i) => keep[i])
}

function channel(
  samples: Sample[],
  c: number,
  tolerance: number,
  original: Animatable,
  modulation = true,
): Animatable {
  const values = samples.map((s) => s.v[c] as number)
  const first = values[0] ?? original.value
  const flat = values.every((v) => Math.abs(v - first) <= tolerance)
  const base: Animatable = { value: first }
  if (modulation && original.modulation) base.modulation = original.modulation
  if (flat) return base
  const keyframes: Keyframe<number>[] = samples.map((s, i) => ({
    time: s.t,
    value: values[i] as number,
    easing: s.easing ?? 'linear',
  }))
  return { ...base, keyframes }
}

function sampleTimes(duration: Seconds, rate: number, extra: readonly number[]): number[] {
  const n = Math.max(1, Math.ceil(duration * rate))
  const times = new Set<number>()
  for (let i = 0; i <= n; i++) times.add((i / n) * duration)
  for (const t of extra) if (t > EPS && t < duration - EPS) times.add(t)
  return [...times].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function boxOf(m: Mat2D): Box {
  const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]]
  const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]]
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

function rotationAt(clip: VisualClip, local: Seconds): number {
  const r = evaluate(clip.transform.rotation, local) % 360
  return Math.min(Math.abs(r), 360 - Math.abs(r))
}

function probeTimes(clip: VisualClip): Seconds[] {
  return [0, clip.duration / 2, Math.max(0, clip.duration - 1e-3)]
}

/** Whether a layer of base size (bw, bh) fills the frame on at least one axis, centred, without rotation. */
function fillsFrame(clip: VisualClip, bw: number, bh: number, f: Frame, bothAxes: boolean): boolean {
  return probeTimes(clip).every((local) => {
    if (rotationAt(clip, local) > 0.01) return false
    const m = layerMatrix(clip, local, clip.start + local, bw, bh, f.width, f.height)
    if (m[0] <= 0 || m[3] <= 0) return false
    const b = boxOf(m)
    const fillsX = b.left <= f.width * 0.02 && b.right >= f.width * 0.98
    const fillsY = b.top <= f.height * 0.02 && b.bottom >= f.height * 0.98
    const centred =
      Math.abs((b.left + b.right) / 2 - f.width / 2) <= f.width * 0.05 &&
      Math.abs((b.top + b.bottom) / 2 - f.height / 2) <= f.height * 0.05
    return bothAxes ? fillsX && fillsY : (fillsX && fillsY) || ((fillsX || fillsY) && centred)
  })
}

/** Maps a normalized position from one frame's safe area to another's. */
function safeMap(v: number, from: Frame, to: Frame, axis: 'x' | 'y'): number {
  const [a0, b0, a1, b1] =
    axis === 'x'
      ? [from.safe.left, from.safe.right, to.safe.left, to.safe.right]
      : [from.safe.top, from.safe.bottom, to.safe.top, to.safe.bottom]
  return a1 + ((v - a0) / Math.max(1 - a0 - b0, EPS)) * (1 - a1 - b1)
}

function safeBox(f: Frame): Box {
  return {
    left: f.safe.left * f.width,
    right: (1 - f.safe.right) * f.width,
    top: f.safe.top * f.height,
    bottom: (1 - f.safe.bottom) * f.height,
  }
}

/** Shift (in pixels) that moves box `b` inside `area` (centred on an axis where it does not fit). */
function shiftInto(b: Box, area: Box): { dx: number; dy: number } {
  const axis = (lo: number, hi: number, alo: number, ahi: number) => {
    if (hi - lo > ahi - alo) return (alo + ahi) / 2 - (lo + hi) / 2
    if (lo < alo) return alo - lo
    if (hi > ahi) return ahi - hi
    return 0
  }
  return {
    dx: axis(b.left, b.right, area.left, area.right),
    dy: axis(b.top, b.bottom, area.top, area.bottom),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Footage

function sourceSize(asset: Asset | undefined): { width: number; height: number } {
  return { width: asset?.width ?? 1920, height: asset?.height ?? 1080 }
}

function reframeFootage(
  clip: VideoClip | ImageClip,
  asset: Asset | undefined,
  from: Frame,
  to: Frame,
  mode: ReframeMode,
  override: FramingOverride,
  plan: ReframePlan | null,
  rate: number,
): VideoClip | ImageClip {
  const { width: W, height: H } = sourceSize(asset)
  const [bw0, bh0] = fitSize(clip.fit, W, H, from.width, from.height)
  const zoom = Math.max(1, override.zoom ?? 1)
  const target = to.width / to.height
  const k0 = Math.max(to.width / W, to.height / H)
  const sourceTime = (local: Seconds) =>
    clip.type === 'video' ? clip.sourceStart + local * clip.playbackRate : 0

  const cuts =
    plan && clip.type === 'video' && clip.playbackRate > 0
      ? plan.keyframes
          .filter((k) => k.cut)
          .map((k) => (k.t - clip.sourceStart) / clip.playbackRate)
          .filter((t) => t > CUT_GAP && t < clip.duration - EPS)
      : []
  const t = clip.transform
  const extra = [
    ...keyframeTimes(t.x, t.y, t.scaleX, t.scaleY),
    ...cuts.flatMap((c) => [c - CUT_GAP, c]),
    ...(plan && clip.type === 'video' && clip.playbackRate > 0
      ? plan.keyframes.map((k) => (k.t - clip.sourceStart) / clip.playbackRate)
      : []),
  ]

  const samples: Sample[] = sampleTimes(clip.duration, rate, extra).map((local) => {
    const m = layerMatrix(clip, local, clip.start + local, bw0, bh0, from.width, from.height)
    // The part of the source the original clip shows (its own pan and zoom included), in normalized units.
    const u0 = clamp(-m[4] / m[0], 0, 1)
    const u1 = clamp((from.width - m[4]) / m[0], 0, 1)
    const v0 = clamp(-m[5] / m[3], 0, 1)
    const v1 = clamp((from.height - m[5]) / m[3], 0, 1)
    const vw = Math.max((u1 - u0) * W, 1)
    const vh = Math.max((v1 - v0) * H, 1)
    let cx = (u0 + u1) / 2
    let cy = (v0 + v1) / 2
    let k: number
    if (mode === 'fit') {
      k = Math.min(to.width / vw, to.height / vh)
    } else {
      let cw = vw / vh > target ? vh * target : vw
      cw /= zoom
      const ch = cw / target
      if (mode === 'auto' && plan) {
        const c = cropAt(plan, sourceTime(local))
        cx = c.x + c.width / 2
        cy = c.y + c.height / 2
      }
      cx += ((override.offsetX ?? 0) * cw) / W
      cy += ((override.offsetY ?? 0) * ch) / H
      const hw = cw / W / 2
      const hh = ch / H / 2
      cx = u1 - u0 <= 2 * hw + EPS ? (u0 + u1) / 2 : clamp(cx, u0 + hw, u1 - hw)
      cy = v1 - v0 <= 2 * hh + EPS ? (v0 + v1) / 2 : clamp(cy, v0 + hh, v1 - hh)
      k = to.width / cw
    }
    const scale = k / k0
    const x = 0.5 + ((0.5 - cx) * W * k) / to.width
    const y = 0.5 + ((0.5 - cy) * H * k) / to.height
    const isCutGap = cuts.some((c) => Math.abs(local - (c - CUT_GAP)) < EPS)
    const isCut = cuts.some((c) => Math.abs(local - c) < EPS)
    return {
      t: local,
      v: [x, y, scale],
      ...(isCutGap ? { keep: true, easing: 'hold' as const } : isCut ? { keep: true } : {}),
    }
  })
  const kept = simplify(samples, [POSITION_TOLERANCE, POSITION_TOLERANCE, SCALE_TOLERANCE])
  const scale = channel(kept, 2, SCALE_TOLERANCE, t.scaleX)
  return {
    ...clip,
    fit: 'cover',
    transform: {
      ...t,
      x: channel(kept, 0, POSITION_TOLERANCE, t.x),
      y: channel(kept, 1, POSITION_TOLERANCE, t.y),
      scaleX: scale,
      scaleY: { ...scale, ...(t.scaleY.modulation ? { modulation: t.scaleY.modulation } : {}) },
      anchorX: 0.5,
      anchorY: 0.5,
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays and text

function moveIntoSafeArea<C extends VisualClip>(clip: C, to: Frame, base: (c: C) => [number, number]): C {
  const local = clip.duration / 2
  const [bw, bh] = base(clip)
  let box = boxOf(layerMatrix(clip, local, clip.start + local, bw, bh, to.width, to.height))
  const area = safeBox(to)
  const fit = Math.min(
    1,
    (area.right - area.left) / Math.max(box.right - box.left, EPS),
    (area.bottom - area.top) / Math.max(box.bottom - box.top, EPS),
  )
  let out = clip
  if (fit < 1 - EPS) {
    out = {
      ...out,
      transform: {
        ...out.transform,
        scaleX: mapAnimatable(out.transform.scaleX, (v) => v * fit),
        scaleY: mapAnimatable(out.transform.scaleY, (v) => v * fit),
      },
    }
    const [bw2, bh2] = base(out)
    box = boxOf(layerMatrix(out, local, out.start + local, bw2, bh2, to.width, to.height))
  }
  const { dx, dy } = shiftInto(box, area)
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return out
  return {
    ...out,
    transform: {
      ...out.transform,
      x: mapAnimatable(out.transform.x, (v) => v + dx / to.width),
      y: mapAnimatable(out.transform.y, (v) => v + dy / to.height),
    },
  }
}

function placeOverlay<C extends VisualClip>(
  clip: C,
  from: Frame,
  to: Frame,
  base0: [number, number],
  base: (c: C) => [number, number],
  override: FramingOverride,
): C {
  const base1 = base(clip)
  const zoom = override.zoom ?? 1
  const rx = (to.short / from.short) * (base0[0] / Math.max(base1[0], EPS)) * zoom
  const ry = (to.short / from.short) * (base0[1] / Math.max(base1[1], EPS)) * zoom
  const t = clip.transform
  const moved: C = {
    ...clip,
    transform: {
      ...t,
      x: mapAnimatable(t.x, (v) => safeMap(v, from, to, 'x') + (override.offsetX ?? 0)),
      y: mapAnimatable(t.y, (v) => safeMap(v, from, to, 'y') + (override.offsetY ?? 0)),
      scaleX: mapAnimatable(t.scaleX, (v) => v * rx),
      scaleY: mapAnimatable(t.scaleY, (v) => v * ry),
    },
  }
  return moveIntoSafeArea(moved, to, base)
}

function scaleTextStyle(style: TextClip['style'], k: number): TextClip['style'] {
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

function textBlock(
  clip: TextClip,
  to: Frame,
  measure: (text: string, font: string) => number,
): [number, number] {
  const fontPx = fontPxFor(clip.style, to.height)
  const font = cssFont(clip.style, fontPx)
  const padding =
    fontPx * 0.15 +
    (clip.style.stroke?.width ?? 0) +
    (clip.style.background?.padding ?? 0) * (to.height / 1080)
  const layout = layoutText({
    text: clip.text,
    style: clip.style,
    canvasWidth: to.width,
    canvasHeight: to.height,
    font,
    padding,
    measure: (s) => measure(s, font),
  })
  return [layout.width, layout.height]
}

function placeText(
  clip: TextClip,
  from: Frame,
  to: Frame,
  override: FramingOverride,
  measure: (text: string, font: string) => number,
): TextClip {
  // Same size relative to the shorter side: fontSize is defined at a 1080-pixel-tall canvas.
  const k = (from.height / from.short) * (to.short / to.height) * (override.zoom ?? 1)
  const safeWidth = 1 - to.safe.left - to.safe.right
  let style = scaleTextStyle(clip.style, k)
  style = {
    ...style,
    maxWidth: Math.min(clip.style.maxWidth * (from.width / from.short) * (to.short / to.width), safeWidth),
  }
  let out: TextClip = { ...clip, style }
  const local = clip.duration / 2
  const scaleY = Math.abs(evaluate(clip.transform.scaleY, local)) || 1
  const [, height] = textBlock(out, to, measure)
  const maxHeight = (1 - to.safe.top - to.safe.bottom) * to.height * MAX_TEXT_SHARE
  if (height * scaleY > maxHeight) {
    const fontPx = fontPxFor(style, to.height)
    const minPx = Math.min(fontPx, MIN_TEXT_PX * to.short)
    const shrink = Math.max(minPx / fontPx, maxHeight / (height * scaleY))
    out = { ...out, style: scaleTextStyle(out.style, shrink) }
  }
  const t = out.transform
  out = {
    ...out,
    transform: {
      ...t,
      x: mapAnimatable(t.x, (v) => safeMap(v, from, to, 'x') + (override.offsetX ?? 0)),
      y: mapAnimatable(t.y, (v) => safeMap(v, from, to, 'y') + (override.offsetY ?? 0)),
    },
  }
  return moveIntoSafeArea(out, to, (c) => textBlock(c, to, measure))
}

// ---------------------------------------------------------------------------------------------------------------

/** The project laid out for another aspect ratio, and what happened to each clip. */
export function convertToFormat(
  project: Project,
  aspect: AspectPreset,
  options: FormatOptions = {},
): FormatConversion {
  const clips: Record<Id, ClipFraming> = {}
  const unanalysed = new Set<Id>()
  const { width, height } = formatSize(project, aspect)
  if (aspect === project.settings.aspect && width === project.settings.width) {
    for (const clip of Object.values(project.clips)) if (clip.type !== 'audio') clips[clip.id] = 'unchanged'
    return { project, clips, unanalysed: [] }
  }
  const from = frame(project.settings.width, project.settings.height, project.settings.aspect)
  const to = frame(width, height, aspect)
  const measure = options.measure ?? defaultMeasure
  const rate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
  const plans = new Map<Id, ReframePlan>()
  const planFor = (asset: Asset) => {
    let plan = plans.get(asset.id)
    if (!plan) {
      plan = reframePlanFor(asset, project.analysis.visual[asset.id], aspect)
      plans.set(asset.id, plan)
    }
    return plan
  }

  const out: Project = { ...project, settings: { ...project.settings, aspect, width, height }, clips: {} }
  for (const clip of Object.values(project.clips)) {
    if (clip.type === 'audio' || clip.type === 'adjustment') {
      out.clips[clip.id] = clip
      if (clip.type === 'adjustment') clips[clip.id] = 'unchanged'
      continue
    }
    const override = options.overrides?.[clip.id] ?? {}
    if (clip.type === 'text') {
      out.clips[clip.id] = placeText(clip, from, to, override, measure)
      clips[clip.id] = 'text'
      continue
    }
    if (clip.type === 'video' || clip.type === 'image') {
      const asset = project.assets[clip.assetId]
      const { width: W, height: H } = sourceSize(asset)
      const base0 = fitSize(clip.fit, W, H, from.width, from.height)
      if (fillsFrame(clip, base0[0], base0[1], from, false)) {
        const mode = override.mode ?? options.reframe ?? 'auto'
        const analysed = asset ? readSubjectTrack(project.analysis.visual[asset.id]) !== null : false
        if (mode === 'auto' && !analysed && asset) unanalysed.add(asset.id)
        const plan = mode === 'auto' && asset && analysed ? planFor(asset) : null
        out.clips[clip.id] = reframeFootage(clip, asset, from, to, mode, override, plan, rate)
        clips[clip.id] = mode === 'fit' ? 'fit' : plan ? 'reframed' : 'centred'
        continue
      }
      out.clips[clip.id] = placeOverlay(
        clip,
        from,
        to,
        base0,
        (c) => fitSize(c.fit, W, H, to.width, to.height),
        override,
      )
      clips[clip.id] = 'moved'
      continue
    }
    // Solids and generators are drawn at the canvas size, so full-frame ones adapt by themselves.
    if (fillsFrame(clip, from.width, from.height, from, true)) {
      out.clips[clip.id] = clip
      clips[clip.id] = 'unchanged'
      continue
    }
    out.clips[clip.id] = placeOverlay(
      clip,
      from,
      to,
      [from.width, from.height],
      () => [to.width, to.height],
      override,
    )
    clips[clip.id] = 'moved'
  }
  return { project: out, clips, unanalysed: [...unanalysed] }
}

/** The project laid out for another aspect ratio (see convertToFormat). */
export function projectForFormat(
  project: Project,
  aspect: AspectPreset,
  options: FormatOptions = {},
): Project {
  return convertToFormat(project, aspect, options).project
}
