import { produce } from 'immer'
import { evaluate } from '../../../engine/animation.ts'
import {
  applyCommand,
  EditError,
  type Clip,
  type EditCommand,
  type Project,
  type VisualClip,
} from '../../../model/index.ts'
import { dispatch, editor } from '../../state/project.ts'

/*
 * Dragging the selected clip on the preview: inside its outline moves it, a corner scales it, the knob above the top
 * edge rotates it. A drag writes the same commands as Inspector › Transform, so the two always agree, and is one undo
 * step.
 */

export type Point = [number, number]
export type HandleMode = 'move' | 'scale' | 'rotate'
type TransformKey = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'
export type TransformValues = Record<TransformKey, number>
type Size = { width: number; height: number }
export type DraggableClip = Extract<Clip, { type: 'video' | 'image' | 'text' }>

const KEYS: readonly TransformKey[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation']
/** Distance of the rotate knob beyond the top edge, in CSS pixels. */
const KNOB_OFFSET = 22
/** Width and height of each handle's hit area, in CSS pixels. */
export const HANDLE_HIT = 24
/** A press that moves less than this many CSS pixels is a click, and changes nothing. */
export const CLICK_SLOP = 2
/** Inspector › Transform › Scale stops at 1%. */
const MIN_SCALE = 0.01
const SNAP_DEGREES = 15
const LABELS: Record<HandleMode, string> = { move: 'Move clip', scale: 'Scale clip', rotate: 'Rotate clip' }

const isTransformable = (clip: Clip | undefined): clip is DraggableClip =>
  !!clip && (clip.type === 'video' || clip.type === 'image' || clip.type === 'text')

/**
 * Why a clip with Inspector › Transform has no handles, said by the outline when a drag starts on it: its track is
 * locked, or it is a lyric line (lyric lines move together, from the lyric Inspector's Position).
 */
export function blockedNote(project: Project, clip: Clip | undefined): string | null {
  if (!isTransformable(clip)) return null
  if (project.tracks.find((t) => t.id === clip.trackId)?.locked)
    return 'That track is locked. Unlock it to edit.'
  if (clip.type === 'text' && clip.lyricLineId) return 'Lyrics move together. Use Position in the Inspector.'
  return null
}

/** Video, image and text clips get handles, except lyric lines and clips on locked tracks. */
export function canDrag(project: Project, clip: Clip | undefined): clip is DraggableClip {
  return isTransformable(clip) && !blockedNote(project, clip)
}

/** The clip's transform as drawn at clip-local time t (keyframes applied, music reactions not). */
export function transformAt(clip: VisualClip, t: number): TransformValues {
  const tr = clip.transform
  return {
    x: evaluate(tr.x, t),
    y: evaluate(tr.y, t),
    scaleX: evaluate(tr.scaleX, t),
    scaleY: evaluate(tr.scaleY, t),
    rotation: evaluate(tr.rotation, t),
  }
}

/** For an outline from selectionOutline: the middle of its top edge, the clip's up direction and the rotate knob. */
export function knobOf(corners: Point[]): { topMid: Point; up: Point; knob: Point } {
  const [tl = [0, 0], tr = [0, 0], br = [0, 0], bl = [0, 0]] = corners
  const topMid: Point = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2]
  let ux = topMid[0] - (bl[0] + br[0]) / 2
  let uy = topMid[1] - (bl[1] + br[1]) / 2
  const len = Math.hypot(ux, uy)
  if (len < 1e-6) [ux, uy] = [0, -1]
  else [ux, uy] = [ux / len, uy / len]
  return { topMid, up: [ux, uy], knob: [topMid[0] + ux * KNOB_OFFSET, topMid[1] + uy * KNOB_OFFSET] }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const within = (p: Point, r: Rect) =>
  p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height
const clampTo = (p: Point, r: Rect): Point => [
  Math.min(Math.max(p[0], r.x), r.x + r.width),
  Math.min(Math.max(p[1], r.y), r.y + r.height),
]

/** Where the segment from `a`, inside r, towards `b` leaves r (b itself when it is inside). */
function exitPoint(a: Point, b: Point, r: Rect): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t = 1
  if (dx > 0) t = Math.min(t, (r.x + r.width - a[0]) / dx)
  if (dx < 0) t = Math.min(t, (r.x - a[0]) / dx)
  if (dy > 0) t = Math.min(t, (r.y + r.height - a[1]) / dy)
  if (dy < 0) t = Math.min(t, (r.y - a[1]) / dy)
  return [a[0] + dx * t, a[1] + dy * t]
}

/**
 * Where to draw the corner handles and the rotate knob so each one's whole hit area is on the visible stage (`view`,
 * in frame pixels; null when unknown). A corner off the stage sits where the line from the anchor to it leaves the
 * stage, still scaling from there. The knob goes beyond the top edge, or inside it when there is no room (a
 * full-frame clip at Fit), or where the clip's up direction from the anchor leaves the stage when the top edge is off
 * it; `stem` is null in that last case.
 */
export function placeHandles(
  corners: Point[],
  pivot: Point,
  view: Rect | null,
): { corners: Point[]; knob: Point; stem: [Point, Point] | null } {
  const { topMid, up, knob } = knobOf(corners)
  if (!view) return { corners, knob, stem: [topMid, knob] }
  const half = HANDLE_HIT / 2
  const r: Rect = {
    x: view.x + half,
    y: view.y + half,
    width: Math.max(0, view.width - HANDLE_HIT),
    height: Math.max(0, view.height - HANDLE_HIT),
  }
  const anchored = within(pivot, r)
  const reach = (p: Point): Point => (within(p, r) ? p : anchored ? exitPoint(pivot, p, r) : clampTo(p, r))
  const placed = corners.map(reach)
  if (within(knob, r)) return { corners: placed, knob, stem: [topMid, knob] }
  const inside: Point = [2 * topMid[0] - knob[0], 2 * topMid[1] - knob[1]]
  if (within(inside, r)) return { corners: placed, knob: inside, stem: [topMid, inside] }
  const far: Point = [pivot[0] + up[0] * 1e6, pivot[1] + up[1] * 1e6]
  return { corners: placed, knob: anchored ? exitPoint(pivot, far, r) : clampTo(knob, r), stem: null }
}

/**
 * The resize cursor for corner i of an outline: along the corner's diagonal as the clip is turned (top-left is
 * nwse-resize upright), whatever the box's proportions, since a corner scales both axes.
 */
export function resizeCursor(corners: Point[], i: number): string {
  const at = (k: number): Point => corners[(k + 4) % 4] ?? [0, 0]
  const unit = (a: Point, b: Point): Point => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1
    return [(a[0] - b[0]) / len, (a[1] - b[1]) / len]
  }
  const c = at(i)
  const a = unit(c, at(i - 1))
  const b = unit(c, at(i + 1))
  const deg = ((Math.atan2(a[1] + b[1], a[0] + b[0]) * 180) / Math.PI + 360) % 180
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4] ?? 'move'
}

/** Rounded to whole project pixels, as Inspector › Transform › Position shows it. */
const toPixel = (v: number, size: number) => Math.round((v - 0.5) * size) / size + 0.5

export function moved(
  start: TransformValues,
  from: Point,
  to: Point,
  frame: Size,
  canvas: Size,
  shift: boolean,
): Partial<TransformValues> {
  let dx = to[0] - from[0]
  let dy = to[1] - from[1]
  if (shift) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0
    else dx = 0
  }
  return {
    x: toPixel(start.x + dx / frame.width, canvas.width),
    y: toPixel(start.y + dy / frame.height, canvas.height),
  }
}

/** Both axes by the change in the pointer's distance from the anchor, so the aspect ratio holds. */
export function scaled(
  start: TransformValues,
  from: Point,
  to: Point,
  pivot: Point,
): Partial<TransformValues> {
  const before = Math.hypot(from[0] - pivot[0], from[1] - pivot[1])
  if (before < 1) return {}
  const smallest = Math.min(Math.abs(start.scaleX), Math.abs(start.scaleY)) || 1
  const f = Math.max(Math.hypot(to[0] - pivot[0], to[1] - pivot[1]) / before, MIN_SCALE / smallest)
  return {
    scaleX: Math.round(start.scaleX * f * 1000) / 1000,
    scaleY: Math.round(start.scaleY * f * 1000) / 1000,
  }
}

/** Degrees clockwise from the anchor to p (screen y points down). */
export function angleOf(p: Point, pivot: Point): number {
  return (Math.atan2(p[1] - pivot[1], p[0] - pivot[0]) * 180) / Math.PI
}

/** The turn from angle a to angle b the short way round, in degrees. */
export function turn(a: number, b: number): number {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

export function rotated(start: number, turned: number, snap: boolean): number {
  const r = start + turned
  return snap ? Math.round(r / SNAP_DEGREES) * SNAP_DEGREES : Math.round(r * 10) / 10
}

/**
 * Commands that give the clip these transform values at clip-local time t: the value itself, or, on a keyframed
 * property, the keyframe at t (added if there is none), since the value under keyframes is not what is drawn.
 */
export function transformCommands(
  clip: VisualClip,
  values: Partial<TransformValues>,
  t: number,
): EditCommand[] {
  const commands: EditCommand[] = []
  for (const key of KEYS) {
    const value = values[key]
    if (value === undefined) continue
    const anim = clip.transform[key]
    if (anim.keyframes?.length) {
      const at = anim.keyframes.find((k) => Math.abs(k.time - t) < 1e-6)
      commands.push({
        type: 'keyframe.set',
        clipId: clip.id,
        path: ['transform', key],
        keyframe: { time: t, value, easing: at?.easing ?? 'ease-in-out' },
      })
    } else commands.push({ type: 'clip.set', clipId: clip.id, path: ['transform', key, 'value'], value })
  }
  return commands
}

export interface Drag {
  /** The pointer moved to `to` (CSS pixels in the frame); Shift keeps a move on one axis and snaps rotation. */
  update(to: Point, shift: boolean): void
  end(): void
}

/** How often a drag writes to the project. In between, only the preview and the outline follow the pointer. */
const COMMIT_MS = 100

/**
 * Starts a drag of `clip` at clip-local time t, pressed at `from` on a frame of size `frame` (CSS pixels). Every
 * animation frame, `show` gets the project as the drag has it so far (null when the drag ends), for the preview and
 * the outline. The project itself changes every COMMIT_MS and on release: each change re-renders everything that
 * reads it (Inspector, timeline, library), which would cost frames if done on every pointer move.
 */
export function startDrag(
  mode: HandleMode,
  clip: VisualClip,
  t: number,
  from: Point,
  frame: Size,
  show: (draft: Project | null) => void,
): Drag {
  const start = transformAt(clip, t)
  const pivot: Point = [start.x * frame.width, start.y * frame.height]
  const canvas = editor.getProject().settings
  const coalesceKey = `canvas:${clip.id}:${mode}`
  let active = false
  let lastAngle = angleOf(from, pivot)
  let turned = 0
  let pending: { to: Point; shift: boolean } | null = null
  let unsaved: EditCommand[] | null = null
  let savedAt = performance.now()
  let raf = 0
  const save = () => {
    if (!unsaved) return
    dispatch(unsaved, { coalesceKey, label: LABELS[mode] })
    unsaved = null
    savedAt = performance.now()
  }
  const apply = () => {
    raf = 0
    if (!pending) return
    const { to, shift } = pending
    pending = null
    const values =
      mode === 'move'
        ? moved(start, from, to, frame, canvas, shift)
        : mode === 'scale'
          ? scaled(start, from, to, pivot)
          : { rotation: rotated(start.rotation, turned, shift) }
    const project = editor.getProject()
    const current = project.clips[clip.id]
    if (!current || current.type === 'audio') return
    const commands = transformCommands(current, values, t)
    if (!commands.length) return
    unsaved = commands
    // A frame that saves shows the saved project only: a draft and then the saved copy would draw the preview twice.
    if (performance.now() - savedAt >= COMMIT_MS) {
      save()
      show(editor.getProject())
      return
    }
    try {
      show(produce(project, (draft) => commands.forEach((c) => applyCommand(draft, c))))
    } catch (error) {
      if (!(error instanceof EditError)) throw error
    }
  }
  return {
    update(to, shift) {
      if (!active && Math.hypot(to[0] - from[0], to[1] - from[1]) < CLICK_SLOP) return
      active = true
      if (mode === 'rotate') {
        const a = angleOf(to, pivot)
        turned += turn(lastAngle, a)
        lastAngle = a
      }
      pending = { to, shift }
      raf ||= requestAnimationFrame(apply)
    },
    end() {
      if (raf) cancelAnimationFrame(raf)
      apply()
      save()
      if (active) {
        show(null)
        editor.endGesture()
      }
    },
  }
}
