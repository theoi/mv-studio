/**
 * Pure frame planning: which visual layers are drawn at a time, in what order, with which transitions, and where.
 * Shared by preview and export.
 */
import { evaluateNumber } from './animation.ts'
import type { AudioSampler } from './audioFeatures.ts'
import type { MediaFit, Project, Seconds, Track, Transition, VisualClip } from '../model/types.ts'

const ADJACENT_EPSILON = 1e-3

export type LayerPlan =
  | { kind: 'clip'; clip: VisualClip }
  | { kind: 'adjustment'; clip: VisualClip }
  | {
      kind: 'transition'
      /** null means "nothing" (transparent): fades in from or out to the layers below. */
      from: VisualClip | null
      to: VisualClip | null
      transition: Transition
      progress: number
    }

function visualTracksBottomUp(project: Project): Track[] {
  const visual = project.tracks.filter((t) => t.kind === 'visual' && !t.hidden)
  const soloed = visual.some((t) => t.solo)
  return visual.filter((t) => !soloed || t.solo).reverse()
}

function isVisual(clip: Project['clips'][string]): clip is VisualClip {
  return clip.type !== 'audio'
}

/** Layers to draw at `time`, bottom to top. */
export function planFrame(project: Project, time: Seconds): LayerPlan[] {
  const byTrack = new Map<string, VisualClip[]>()
  for (const clip of Object.values(project.clips)) {
    if (!clip.enabled || !isVisual(clip)) continue
    const list = byTrack.get(clip.trackId) ?? []
    list.push(clip)
    byTrack.set(clip.trackId, list)
  }
  const layers: LayerPlan[] = []
  for (const track of visualTracksBottomUp(project)) {
    const clips = (byTrack.get(track.id) ?? []).sort((a, b) => a.start - b.start)
    for (const clip of clips) {
      const end = clip.start + clip.duration
      if (time < clip.start || time >= end) continue
      if (clip.type === 'adjustment') {
        layers.push({ kind: 'adjustment', clip })
        continue
      }
      const local = time - clip.start
      const tin = clip.transitionIn
      if (tin && tin.duration > 0 && local < tin.duration) {
        const prev = clips.find(
          (c) =>
            c !== clip &&
            c.type !== 'adjustment' &&
            Math.abs(c.start + c.duration - clip.start) < ADJACENT_EPSILON,
        )
        layers.push({
          kind: 'transition',
          from: prev ?? null,
          to: clip,
          transition: tin,
          progress: local / tin.duration,
        })
        continue
      }
      const tout = clip.transitionOut
      if (tout && tout.duration > 0 && local > clip.duration - tout.duration) {
        const progress = (local - (clip.duration - tout.duration)) / tout.duration
        layers.push({ kind: 'transition', from: clip, to: null, transition: tout, progress })
        continue
      }
      layers.push({ kind: 'clip', clip })
    }
  }
  return layers
}

/** Size in canvas pixels of a source with natural size (w, h) fitted into the canvas. */
export function fitSize(
  fit: MediaFit,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
): [number, number] {
  if (fit === 'stretch' || w <= 0 || h <= 0) return [canvasW, canvasH]
  const sx = canvasW / w
  const sy = canvasH / h
  const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
  return [w * s, h * s]
}

/** 2D affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Mat2D = [number, number, number, number, number, number]

/**
 * Maps the unit square (0..1, top-left origin) of a layer with base size (bw, bh) to canvas pixels (top-left origin),
 * applying the clip's transform at its local time.
 */
export function layerMatrix(
  clip: VisualClip,
  localTime: Seconds,
  time: Seconds,
  baseW: number,
  baseH: number,
  canvasW: number,
  canvasH: number,
  audio?: AudioSampler,
): Mat2D {
  const t = clip.transform
  const x = evaluateNumber(t.x, localTime, time, audio) * canvasW
  const y = evaluateNumber(t.y, localTime, time, audio) * canvasH
  const sx = evaluateNumber(t.scaleX, localTime, time, audio)
  const sy = evaluateNumber(t.scaleY, localTime, time, audio)
  const r = (evaluateNumber(t.rotation, localTime, time, audio) * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const w = baseW * sx
  const h = baseH * sy
  const ox = -t.anchorX * w
  const oy = -t.anchorY * h
  // translate(x, y) * rotate(r) * translate(ox, oy) * scale(w, h)
  return [cos * w, sin * w, -sin * h, cos * h, x + cos * ox - sin * oy, y + sin * ox + cos * oy]
}

export function applyMat(m: Mat2D, u: number, v: number): [number, number] {
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]
}
