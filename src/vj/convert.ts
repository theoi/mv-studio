/**
 * Turns a take into ordinary timeline content as edit commands (one dispatch, one undo step):
 * - clip pads become clips on a "VJ clips" track, one per uninterrupted shot (repeated presses of the playing pad
 *   merge, a clip shorter than a frame is dropped, footage that runs out loops);
 * - looks become adjustment clips on "VJ looks" ("Original" leaves a gap);
 * - each effect pad gets its own "VJ <effect>" track with one clip per hit, its amount keyframed (decay envelopes,
 *   strobes, knob moves).
 * Times snap to the project's frame grid. VJ tracks are reused across takes; within a lane the take replaces what
 * was there from its first event to its end. The live preview renders the same conversion, so what the user sees
 * while performing is what lands on the timeline.
 */
import { produce } from 'immer'
import { ease } from '../engine/animation.ts'
import type { PluginCatalogEntry } from '../engine/types.ts'
import { applyCommand, type EditCommand } from '../model/commands.ts'
import {
  anim,
  createImageClip,
  createSolidClip,
  createTrack,
  createVideoClip,
  defaultTransform,
} from '../model/factory.ts'
import type {
  AdjustmentClip,
  Animatable,
  Clip,
  ColorAdjustmentKey,
  ColorAdjustments,
  Easing,
  EffectInstance,
  GeneratorClip,
  JsonObject,
  Keyframe,
  ParamValue,
  Project,
  Seconds,
  Track,
  VisualClip,
} from '../model/types.ts'
import { effectTarget } from './layout.ts'
import { quantizeEvents, type BeatGrid } from './quantize.ts'
import type { ClipPadAction, EffectPadAction, PadSnapshot, QuantizeSettings, Take, VjEvent } from './types.ts'

export interface ConvertOptions {
  catalog: readonly PluginCatalogEntry[]
  /** Where the take ends; defaults to take.end. Live previews pass the song end so open clips stay on screen. */
  end?: Seconds
  grid?: BeatGrid | null
  quantize?: QuantizeSettings | null
  mode?: 'overdub' | 'replace'
  /** Strobe flashes are generated up to this time (live previews refresh before they reach it). */
  horizon?: Seconds
  /**
   * Ids for new tracks, clips and effects. By default they derive from the take id and the clip's lane and start
   * frame, so the live preview and the committed take use the same ids (the preview keeps its decoded media).
   */
  newId?: (suffix: string) => string
}

export interface CurvePoint {
  t: Seconds
  /** Effective amount 0..1. */
  v: number
  easing: Easing
}

export interface Segment {
  start: Seconds
  end: Seconds
  pad: PadSnapshot
  /** Starts with a visible cut even if the previous segment is the same pad (a 'restart' re-press). */
  cut: boolean
}

export interface Hit {
  start: Seconds
  end: Seconds
  points: CurvePoint[]
}

export type Lane =
  | { kind: 'clips' | 'looks'; key: 'clips' | 'looks'; from: Seconds; segments: Segment[] }
  | { kind: 'fx'; key: string; pad: PadSnapshot; from: Seconds; hits: Hit[] }

export interface TakeConversion {
  commands: EditCommand[]
  lanes: Lane[]
  summary: { clips: number; effects: number; looks: number; newTracks: number }
  /** Footage positions after the take for 'resume' pads (to continue from in the next take). */
  cursors: Record<string, Seconds>
}

const EPS = 1e-6
const KNOB_TOLERANCE = 0.01
/** One-shot decay curve, and the curve used to cut one short. */
const DECAY_EASING: Easing = 'ease-out'

const round = (v: number, digits: number) => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export function laneOfClip(clip: Clip): string | undefined {
  const vj = clip.meta?.vj
  if (typeof vj !== 'object' || vj === null || Array.isArray(vj)) return undefined
  const lane = (vj as JsonObject).lane
  return typeof lane === 'string' ? lane : undefined
}

export function takeOfClip(clip: Clip): string | undefined {
  const vj = clip.meta?.vj
  if (typeof vj !== 'object' || vj === null || Array.isArray(vj)) return undefined
  const take = (vj as JsonObject).take
  return typeof take === 'string' ? take : undefined
}

/** Applies commands to a copy of the project (no undo history), e.g. for the live preview. */
export function applyCommands(project: Project, commands: readonly EditCommand[]): Project {
  if (commands.length === 0) return project
  return produce(project, (draft) => {
    for (const cmd of commands) applyCommand(draft, cmd)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Interpretation: events to lanes

function prepareEvents(take: Take, end: Seconds, fps: number, options: ConvertOptions): VjEvent[] {
  const frame = (t: Seconds) => Math.round(t * fps) / fps
  let events = take.events
    .map((e, order) => ({ e: { ...e, t: Math.min(end, Math.max(take.start, e.t)) }, order }))
    .sort((a, b) => a.e.t - b.e.t || a.order - b.order)
    .map((x) => x.e)
  if (options.quantize?.enabled && options.grid)
    events = quantizeEvents(events, options.grid, options.quantize, take.start, 1 / fps)
  const last = frame(end)
  return events.map((e) => ({ ...e, t: Math.min(last, frame(e.t)) }))
}

function switchLane(
  events: readonly VjEvent[],
  take: Take,
  kind: 'clips' | 'looks',
  end: Seconds,
): Lane | null {
  const switches: { t: Seconds; pad: PadSnapshot | null; cut: boolean }[] = []
  let latched: PadSnapshot | null = null
  const momentary: PadSnapshot[] = []
  let current: PadSnapshot | null | undefined
  for (const e of events) {
    if (e.type === 'amount') continue
    const pad = take.pads[e.pad]
    if (!pad || pad.row !== kind) continue
    const isMomentary = pad.action.kind === 'clip' && pad.action.trigger === 'momentary'
    let next: PadSnapshot | null
    let cut = false
    if (e.type === 'press') {
      if (isMomentary) {
        const i = momentary.findIndex((p) => p.id === pad.id)
        if (i >= 0) momentary.splice(i, 1)
        momentary.push(pad)
      } else {
        latched = pad
        momentary.length = 0
      }
      next = pad
      if (current?.id === pad.id) {
        if (pad.action.kind !== 'clip' || pad.action.playback !== 'restart') continue
        cut = true
      }
    } else {
      if (!isMomentary) continue
      const i = momentary.findIndex((p) => p.id === pad.id)
      if (i < 0) continue
      momentary.splice(i, 1)
      next = momentary[momentary.length - 1] ?? latched
      if ((next?.id ?? null) === (current?.id ?? null)) continue
    }
    switches.push({ t: e.t, pad: next, cut })
    current = next
  }
  if (switches.length === 0) return null
  const segments: Segment[] = []
  switches.forEach((s, i) => {
    const segEnd = switches[i + 1]?.t ?? end
    if (segEnd - s.t < EPS || !s.pad) return
    const prev = segments[segments.length - 1]
    if (prev && prev.pad.id === s.pad.id && !s.cut && Math.abs(prev.end - s.t) < EPS) prev.end = segEnd
    else segments.push({ start: s.t, end: segEnd, pad: s.pad, cut: s.cut })
  })
  return { kind, key: kind, from: (switches[0] as { t: Seconds }).t, segments }
}

/** Piecewise-linear knob value over time, starting from the take's initial amount. */
class KnobCurve {
  readonly points: { t: Seconds; v: number }[] = []
  private readonly initial: number
  constructor(initial: number) {
    this.initial = initial
  }
  add(t: Seconds, v: number) {
    const last = this.points[this.points.length - 1]
    if (last && Math.abs(last.t - t) < EPS) last.v = v
    else this.points.push({ t, v })
  }
  at(t: Seconds): number {
    const pts = this.points
    if (pts.length === 0 || t < (pts[0] as { t: Seconds }).t) return this.initial
    let i = pts.length - 1
    while (i > 0 && (pts[i] as { t: Seconds }).t > t) i--
    const a = pts[i] as { t: Seconds; v: number }
    const b = pts[i + 1]
    if (!b || b.t - a.t < EPS) return a.v
    return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
  }
  /** Knob points strictly inside (from, to). */
  between(from: Seconds, to: Seconds) {
    return this.points.filter((p) => p.t > from + EPS && p.t < to - EPS)
  }
}

/** Keeps the points needed to stay within `tolerance` of the curve (Ramer–Douglas–Peucker on values). */
function simplify(points: CurvePoint[], tolerance: number): CurvePoint[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number]
    const pa = points[a] as CurvePoint
    const pb = points[b] as CurvePoint
    let worst = -1
    let worstError = tolerance
    for (let i = a + 1; i < b; i++) {
      const p = points[i] as CurvePoint
      const u = pb.t - pa.t > EPS ? (p.t - pa.t) / (pb.t - pa.t) : 0
      const error = Math.abs(p.v - (pa.v + (pb.v - pa.v) * u))
      if (error > worstError) {
        worst = i
        worstError = error
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** Strobe toggle times in (start, end): on at each grid point, off halfway to the next. */
function strobeToggles(
  start: Seconds,
  end: Seconds,
  perBeat: number,
  grid: BeatGrid | null | undefined,
): { t: Seconds; on: boolean }[] {
  const beats = grid && grid.beats.length >= 2 ? grid.beats : null
  const out: { t: Seconds; on: boolean }[] = []
  const push = (t: Seconds, on: boolean) => {
    if (t > start + EPS && t < end - EPS) out.push({ t, on })
  }
  const period = (i: number) =>
    beats
      ? ((beats[Math.min(i + 1, beats.length - 1)] as number) -
          (beats[Math.min(i, beats.length - 2)] as number)) /
        perBeat
      : 0.5 / perBeat
  // Walk the subdivision grid from the beat at or before `start`.
  let beatIndex = 0
  let t: Seconds
  if (beats) {
    while (beatIndex < beats.length - 1 && (beats[beatIndex + 1] as number) <= start) beatIndex++
    t = beats[beatIndex] as number
    if (t > start) {
      const p = period(0)
      t -= Math.ceil((t - start) / p) * p
    }
  } else t = start
  let guard = 0
  while (t < end && guard++ < 100_000) {
    if (beats && beatIndex < beats.length - 1 && t >= (beats[beatIndex + 1] as number) - EPS) beatIndex++
    const p = period(beatIndex)
    push(t, true)
    push(t + p / 2, false)
    t += p
  }
  return out
}

function fxLanes(events: readonly VjEvent[], take: Take, end: Seconds, options: ConvertOptions): Lane[] {
  interface Open {
    start: Seconds
    peak: number
    knobAtStart: number
  }
  interface State {
    pad: PadSnapshot
    action: EffectPadAction
    played: Seconds | null
    open: Open | null
    holders: number
    knob: KnobCurve
    spans: { start: Seconds; end: Seconds; peak: number; knobAtStart: number }[]
  }
  const states = new Map<string, State>()
  const stateOf = (padId: string): State | null => {
    const pad = take.pads[padId]
    if (!pad || pad.action.kind !== 'effect') return null
    let s = states.get(padId)
    if (!s) {
      s = {
        pad,
        action: pad.action,
        played: null,
        open: null,
        holders: 0,
        knob: new KnobCurve(take.amounts[padId] ?? 1),
        spans: [],
      }
      states.set(padId, s)
    }
    return s
  }
  const close = (s: State, t: Seconds) => {
    if (!s.open) return
    const limit = s.action.trigger === 'one-shot' ? s.open.start + s.action.decay : Infinity
    s.spans.push({ ...s.open, end: Math.min(t, limit) })
    s.open = null
  }
  const open = (s: State, t: Seconds, velocity: number) => {
    const peak = s.action.amount * (s.action.velocity ? velocity : 1)
    s.open = { start: t, peak, knobAtStart: s.knob.at(t) }
  }

  // Knob-only pads with an amount at the take start are on from the start.
  for (const [padId, amount] of Object.entries(take.amounts)) {
    const s = amount > 0 ? stateOf(padId) : null
    if (s && s.action.trigger === 'knob') {
      s.played = take.start
      open(s, take.start, 1)
    }
  }
  for (const e of events) {
    const s = stateOf(e.pad)
    if (!s) continue
    const trigger = s.action.trigger
    if (e.type === 'amount') {
      s.knob.add(e.t, e.value)
      if (trigger !== 'knob') continue
      if (e.value > 0 && !s.open) {
        s.played ??= e.t
        open(s, e.t, 1)
      } else if (e.value <= 0 && s.open) close(s, e.t)
      continue
    }
    if (trigger === 'knob') continue
    if (e.type === 'press') {
      s.played ??= e.t
      if (trigger === 'one-shot') {
        close(s, e.t)
        open(s, e.t, e.velocity)
      } else if (trigger === 'hold') {
        s.holders++
        if (!s.open) open(s, e.t, e.velocity)
      } else if (s.open) close(s, e.t)
      else open(s, e.t, e.velocity)
    } else if (trigger === 'hold') {
      s.holders = Math.max(0, s.holders - 1)
      if (s.holders === 0) close(s, e.t)
    }
  }

  const lanes: Lane[] = []
  for (const s of states.values()) {
    close(s, end)
    if (s.played === null) continue
    const hits: Hit[] = []
    for (const span of s.spans) {
      if (span.end - span.start < EPS) continue
      hits.push({ start: span.start, end: span.end, points: hitCurve(s, span, options) })
    }
    lanes.push({ kind: 'fx', key: `fx:${s.pad.id}`, pad: s.pad, from: s.played, hits })
  }
  return lanes.sort((a, b) => (a.kind === 'fx' && b.kind === 'fx' ? a.pad.index - b.pad.index : 0))
}

function hitCurve(
  s: { action: EffectPadAction; knob: KnobCurve },
  span: { start: Seconds; end: Seconds; peak: number; knobAtStart: number },
  options: ConvertOptions,
): CurvePoint[] {
  const { action } = s
  if (action.trigger === 'one-shot') {
    const p = span.peak * span.knobAtStart
    const full = span.start + action.decay
    if (span.end >= full - EPS)
      return [
        { t: span.start, v: p, easing: DECAY_EASING },
        { t: full, v: 0, easing: 'linear' },
      ]
    const cutValue = p * (1 - ease(DECAY_EASING, (span.end - span.start) / action.decay))
    return [
      { t: span.start, v: p, easing: DECAY_EASING },
      { t: span.end, v: cutValue, easing: 'linear' },
    ]
  }
  const value = (t: Seconds) => Math.max(0, Math.min(1, span.peak * s.knob.at(t)))
  const level = simplify(
    [
      { t: span.start, v: value(span.start), easing: 'linear' as Easing },
      ...s.knob
        .between(span.start, span.end)
        .map((k) => ({ t: k.t, v: value(k.t), easing: 'linear' as Easing })),
      { t: span.end, v: value(span.end), easing: 'linear' as Easing },
    ],
    KNOB_TOLERANCE,
  )
  const strobe = action.fx.type === 'flash' ? action.fx.strobe : undefined
  if (!strobe) return level
  const until = Math.min(span.end, options.horizon ?? Infinity)
  const levelAt = (t: Seconds) => {
    let i = level.length - 1
    while (i > 0 && (level[i] as CurvePoint).t > t) i--
    const a = level[i] as CurvePoint
    const b = level[i + 1]
    return b && b.t - a.t > EPS ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : a.v
  }
  return [
    { t: span.start, v: levelAt(span.start), easing: 'hold' },
    ...strobeToggles(span.start, until, strobe, options.grid).map((x) => ({
      t: x.t,
      v: x.on ? levelAt(x.t) : 0,
      easing: 'hold' as Easing,
    })),
  ]
}

/** Lanes a take plays (clips, looks, one per effect pad), from its events. */
export function interpretTake(
  take: Take,
  fps: number,
  options: ConvertOptions,
): { lanes: Lane[]; start: Seconds; end: Seconds } {
  const end = options.end ?? take.end ?? take.start
  const events = prepareEvents(take, end, fps, options)
  const endF = Math.round(end * fps) / fps
  const startF = Math.round(take.start * fps) / fps
  const lanes: Lane[] = [...fxLanes(events, take, endF, options)]
  const looks = switchLane(events, take, 'looks', endF)
  if (looks) lanes.push(looks)
  const clips = switchLane(events, take, 'clips', endF)
  if (clips) lanes.push(clips)
  return { lanes, start: startF, end: endF }
}

/** Value of a curve at `t` (the same interpolation the renderer uses for the resulting keyframes). */
export function curveValue(points: readonly CurvePoint[], t: Seconds): number {
  if (points.length === 0) return 0
  let i = points.length - 1
  while (i > 0 && (points[i] as CurvePoint).t > t) i--
  const a = points[i] as CurvePoint
  const b = points[i + 1]
  if (!b || t <= a.t) return a.v
  return a.v + (b.v - a.v) * ease(a.easing, (t - a.t) / (b.t - a.t))
}

/** How lit each pad is at time `t` (0..1): the playing clip and look, and each effect's current amount. */
export function padLevelsAt(lanes: readonly Lane[], t: Seconds): Map<string, number> {
  const out = new Map<string, number>()
  for (const lane of lanes) {
    if (lane.kind === 'fx') {
      const hit = lane.hits.find((h) => t >= h.start && t < h.end)
      if (hit) out.set(lane.pad.id, Math.max(0, Math.min(1, curveValue(hit.points, t))))
    } else {
      const seg = lane.segments.find((s) => t >= s.start && t < s.end)
      if (seg) out.set(seg.pad.id, 1)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Clips

function vjMeta(take: Take, lane: string, pad: PadSnapshot): JsonObject {
  return { vj: { take: take.id, lane, pad: pad.id } }
}

function visualBase(id: string, trackId: string, start: Seconds, duration: Seconds) {
  return {
    id,
    trackId,
    start,
    duration,
    enabled: true,
    transform: defaultTransform(),
    opacity: anim(1),
    blendMode: 'normal' as const,
    effects: [] as EffectInstance[],
  }
}

function animFrom(points: readonly CurvePoint[], clipStart: Seconds, map: (v: number) => number): Animatable {
  const keys: Keyframe<number>[] = []
  for (const p of points) {
    const key = { time: round(p.t - clipStart, 6), value: round(map(p.v), 4), easing: p.easing }
    const last = keys[keys.length - 1]
    if (last && Math.abs(last.time - key.time) < EPS) keys[keys.length - 1] = key
    else keys.push(key)
  }
  const first = keys[0]
  if (!first) return anim(round(map(0), 4))
  if (keys.every((k) => k.value === first.value)) return anim(first.value)
  return { value: first.value, keyframes: keys }
}

function staticParams(
  values: Record<string, ParamValue> | undefined,
): Record<string, Animatable<ParamValue>> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, anim(v)]))
}

function adjustmentsOf(values: Partial<Record<ColorAdjustmentKey, number>> | undefined): ColorAdjustments {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, anim(v)]))
}

interface ClipContext {
  project: Project
  take: Take
  options: ConvertOptions
  fps: number
  id: (suffix: string) => string
  cursors: Record<string, Seconds>
  /** Times the footage is frozen (sorted, not overlapping). */
  freeze: { start: Seconds; end: Seconds }[]
}

const frameOf = (t: Seconds, fps: number) => Math.round(t * fps)

/** Clips for one shot of a clip pad. Footage that ends before the shot does loops, as consecutive clips. */
function shotClips(seg: Segment, trackId: string, c: ClipContext): VisualClip[] {
  const action = seg.pad.action as ClipPadAction
  const source = action.source
  const meta = vjMeta(c.take, 'clips', seg.pad)
  const duration = seg.end - seg.start
  const clipId = (piece = 0) => c.id(`clips:${frameOf(seg.start, c.fps)}:${piece}`)
  if (!source) return []
  if (source.type === 'solid') {
    const clip = createSolidClip({ trackId, color: source.color, start: seg.start, duration })
    return [{ ...clip, id: clipId(), name: seg.pad.label, meta }]
  }
  if (source.type === 'generator') {
    const entry = c.options.catalog.find((e) => e.id === source.generatorId)
    const params = staticParams(source.params)
    for (const [key, modulation] of Object.entries(entry?.defaultModulation ?? {})) {
      const spec = entry?.params.find((p) => p.key === key)
      const value = params[key]?.value ?? (spec ? spec.default : 0)
      params[key] = { value, modulation }
    }
    const clip: GeneratorClip = {
      ...visualBase(clipId(), trackId, seg.start, duration),
      type: 'generator',
      generatorId: source.generatorId,
      params,
      name: seg.pad.label,
      meta,
    }
    return [clip]
  }
  const asset = c.project.assets[source.assetId]
  if (!asset) return []
  if (asset.kind === 'image') {
    const clip = createImageClip({ trackId, assetId: asset.id, start: seg.start, duration })
    return [{ ...clip, id: clipId(), name: seg.pad.label, meta }]
  }
  if (asset.kind !== 'video') return []
  const length = asset.duration && asset.duration > 0 ? asset.duration : Infinity
  const nearEnd = (pos: Seconds) => pos >= length - 0.5 / c.fps
  let pos =
    action.playback === 'restart'
      ? 0
      : action.playback === 'sync'
        ? seg.start % length
        : (c.cursors[seg.pad.id] ?? 0) % length
  if (nearEnd(pos)) pos = 0
  const out: VisualClip[] = []
  const push = (start: Seconds, len: Seconds, sourceStart: Seconds, playbackRate: number) => {
    const clip = createVideoClip({ trackId, assetId: asset.id, start, duration: len, sourceStart })
    out.push({ ...clip, id: clipId(out.length), name: seg.pad.label, muted: true, playbackRate, meta })
  }
  let t = seg.start
  while (seg.end - t > EPS) {
    const window = c.freeze.find((w) => w.end > t + EPS && w.start < seg.end - EPS)
    if (window && window.start <= t + EPS) {
      const until = Math.min(window.end, seg.end)
      push(t, until - t, pos, 0)
      t = until
      continue
    }
    const until = Math.min(seg.end, window ? window.start : Infinity)
    if (action.playback === 'sync' && t > seg.start) pos = t % length
    while (until - t > EPS) {
      const len = Math.min(until - t, length - pos)
      push(t, len, pos, 1)
      t += len
      pos += len
      if (nearEnd(pos)) pos = 0
    }
  }
  if (action.playback === 'resume') c.cursors[seg.pad.id] = pos
  return out
}

function lookClip(seg: Segment, trackId: string, c: ClipContext): VisualClip | null {
  if (seg.pad.action.kind !== 'look' || !seg.pad.action.look) return null
  const look = seg.pad.action.look
  const id = c.id(`looks:${frameOf(seg.start, c.fps)}`)
  const clip: AdjustmentClip = {
    ...visualBase(id, trackId, seg.start, seg.end - seg.start),
    type: 'adjustment',
    adjustments: adjustmentsOf(look.adjustments),
    effects: (look.effects ?? []).map((e, i) => ({
      id: `${id}:effect:${i}`,
      effectId: e.effectId,
      enabled: true,
      params: staticParams(e.params),
    })),
    name: seg.pad.label,
    meta: vjMeta(c.take, 'looks', seg.pad),
  }
  return clip
}

function hitClip(lane: Extract<Lane, { kind: 'fx' }>, hit: Hit, trackId: string, c: ClipContext): VisualClip {
  const pad = lane.pad
  const fx = (pad.action as EffectPadAction).fx
  const meta = vjMeta(c.take, lane.key, pad)
  const duration = hit.end - hit.start
  const id = c.id(`${lane.key}:${frameOf(hit.start, c.fps)}`)
  if (fx.type === 'flash') {
    const clip = createSolidClip({ trackId, color: fx.color, start: hit.start, duration })
    return { ...clip, id, name: pad.label, meta, opacity: animFrom(hit.points, hit.start, (v) => v) }
  }
  const base: AdjustmentClip = {
    ...visualBase(id, trackId, hit.start, duration),
    type: 'adjustment',
    name: pad.label,
    meta,
  }
  if (fx.type === 'adjust') {
    const adjustments: ColorAdjustments = {}
    for (const [key, full] of Object.entries(fx.adjustments)) {
      adjustments[key as ColorAdjustmentKey] = animFrom(hit.points, hit.start, (v) => full * v)
    }
    return { ...base, adjustments }
  }
  if (fx.type === 'freeze') return base
  const target = effectTarget(fx, c.options.catalog)
  const params = staticParams(fx.params)
  if (target.kind === 'param')
    params[target.key] = animFrom(hit.points, hit.start, (v) => target.off + (target.on - target.off) * v)
  const effect: EffectInstance = { id: `${id}:effect`, effectId: fx.effectId, enabled: true, params }
  return {
    ...base,
    effects: [effect],
    ...(target.kind === 'opacity' ? { opacity: animFrom(hit.points, hit.start, (v) => v) } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tracks

const MEDIA_TYPES = new Set(['video', 'image', 'generator', 'solid'])

function isFreezeLane(lane: Lane): boolean {
  return lane.kind === 'fx' && lane.pad.action.kind === 'effect' && lane.pad.action.fx.type === 'freeze'
}

function mergeWindows(
  spans: readonly { start: Seconds; end: Seconds }[],
): { start: Seconds; end: Seconds }[] {
  const out: { start: Seconds; end: Seconds }[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + EPS) last.end = Math.max(last.end, s.end)
    else out.push({ start: s.start, end: s.end })
  }
  return out
}

function laneCategory(lane: string): number {
  return lane.startsWith('fx:') ? 0 : lane === 'looks' ? 1 : 2
}

function laneTrackName(lane: Lane): string {
  if (lane.kind === 'fx') return `VJ ${lane.pad.label}`
  return lane.kind === 'clips' ? 'VJ clips' : 'VJ looks'
}

/** Where a project's first VJ tracks go: above its top-most footage or visuals track, below text-only tracks. */
function anchorIndex(project: Project, tracks: readonly Track[]): number {
  const clips = Object.values(project.clips)
  const on = (t: Track) => clips.filter((c) => c.trackId === t.id)
  const media = tracks.findIndex((t) => t.kind === 'visual' && on(t).some((c) => MEDIA_TYPES.has(c.type)))
  if (media >= 0) return media
  const notText = tracks.findIndex((t) => t.kind === 'visual' && !on(t).some((c) => c.type === 'text'))
  if (notText >= 0) return notText
  const audio = tracks.findIndex((t) => t.kind === 'audio')
  return audio >= 0 ? audio : tracks.length
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Edit commands that put the take on the timeline. Dispatch them as one step:
 *   editor.dispatch(takeToCommands(project, take, opts).commands, { label: 'Record VJ take' })
 */
export function takeToCommands(project: Project, take: Take, options: ConvertOptions): TakeConversion {
  const fps = project.settings.fps > 0 ? project.settings.fps : 30
  const id = (suffix: string) => options.newId?.(suffix) ?? `${take.id}:${suffix}`
  const minPiece = 0.5 / fps
  const { lanes, start, end } = interpretTake(take, fps, options)
  const commands: EditCommand[] = []
  const summary = { clips: 0, effects: 0, looks: 0, newTracks: 0 }
  const cursors: Record<string, Seconds> = { ...take.cursors }
  const freeze = mergeWindows(lanes.filter(isFreezeLane).flatMap((l) => (l.kind === 'fx' ? l.hits : [])))
  const ctx: ClipContext = { project, take, options, fps, id, cursors, freeze }

  const tracks = [...project.tracks]
  const allClips = Object.values(project.clips)
  const usable = (t: Track | undefined): t is Track => !!t && t.kind === 'visual' && !t.locked && !t.hidden
  const trackById = (trackId: string) => tracks.find((t) => t.id === trackId)
  const vjTracks = new Map<string, number>()
  for (const clip of allClips) {
    const lane = laneOfClip(clip)
    if (lane !== undefined)
      vjTracks.set(clip.trackId, Math.min(vjTracks.get(clip.trackId) ?? 9, laneCategory(lane)))
  }
  const findTrack = (laneKey: string, name: string): Track | undefined => {
    for (const clip of allClips) {
      if (laneOfClip(clip) !== laneKey) continue
      const track = trackById(clip.trackId)
      if (usable(track)) return track
    }
    return tracks.find(
      (t) =>
        usable(t) &&
        t.name === name &&
        allClips.every((c) => c.trackId !== t.id || laneOfClip(c) === laneKey),
    )
  }

  // Assign tracks, creating the missing ones in order: effects above looks above clips.
  const laneTracks = new Map<string, Track>()
  for (const lane of lanes) {
    if (isFreezeLane(lane)) continue
    const name = laneTrackName(lane)
    const existing = findTrack(lane.key, name)
    if (existing) {
      laneTracks.set(lane.key, existing)
      vjTracks.set(existing.id, Math.min(vjTracks.get(existing.id) ?? 9, laneCategory(lane.key)))
      continue
    }
    if (lane.kind === 'fx' ? lane.hits.length === 0 : lane.segments.length === 0) continue
    const category = laneCategory(lane.key)
    const indexOf = (trackId: string) => tracks.findIndex((t) => t.id === trackId)
    const placed = [...vjTracks.entries()].filter(([trackId]) => indexOf(trackId) >= 0)
    const below = placed.filter(([, c]) => c > category).map(([t]) => indexOf(t))
    const above = placed.filter(([, c]) => c <= category).map(([t]) => indexOf(t))
    const index =
      below.length > 0
        ? Math.min(...below)
        : above.length > 0
          ? Math.max(...above) + 1
          : anchorIndex(project, tracks)
    const track = { ...createTrack('visual', name), id: id(`track:${lane.key}`) }
    tracks.splice(index, 0, track)
    commands.push({ type: 'track.add', track, index })
    laneTracks.set(lane.key, track)
    vjTracks.set(track.id, category)
    summary.newTracks++
  }

  // Clear what each played lane replaces.
  const ranges: { trackId: string; from: Seconds }[] = []
  for (const lane of lanes) {
    const track = laneTracks.get(lane.key)
    if (track) ranges.push({ trackId: track.id, from: options.mode === 'replace' ? start : lane.from })
  }
  if (options.mode === 'replace') {
    for (const trackId of vjTracks.keys()) {
      if (!ranges.some((r) => r.trackId === trackId) && usable(trackById(trackId)))
        ranges.push({ trackId, from: start })
    }
  }
  for (const { trackId, from } of ranges) {
    if (end - from < EPS) continue
    for (const clip of allClips) {
      if (clip.trackId !== trackId) continue
      const s = clip.start
      const e = clip.start + clip.duration
      if (e <= from + EPS || s >= end - EPS) continue
      const keepLeft = from - s >= minPiece
      const keepRight = e - end >= minPiece
      if (keepLeft && keepRight) {
        const middle = id(`split:${clip.id}:a`)
        commands.push(
          { type: 'clip.split', clipId: clip.id, time: from, newClipId: middle },
          { type: 'clip.split', clipId: middle, time: end, newClipId: id(`split:${clip.id}:b`) },
          { type: 'clip.remove', clipIds: [middle] },
        )
      } else if (keepLeft) {
        commands.push({ type: 'clip.trim', clipId: clip.id, start: s, duration: from - s })
      } else if (keepRight) {
        commands.push(
          { type: 'clip.split', clipId: clip.id, time: end, newClipId: id(`split:${clip.id}:b`) },
          { type: 'clip.remove', clipIds: [clip.id] },
        )
      } else commands.push({ type: 'clip.remove', clipIds: [clip.id] })
    }
  }

  // Freezing also holds VJ footage recorded earlier that this take does not replace.
  const clipsTrack = laneTracks.get('clips') ?? findTrack('clips', 'VJ clips')
  if (freeze.length > 0 && clipsTrack) {
    const before = applyCommands(project, commands)
    for (const clip of Object.values(before.clips)) {
      if (clip.trackId !== clipsTrack.id || clip.type !== 'video' || clip.playbackRate === 0) continue
      let target = clip.id
      let s = clip.start
      const e = clip.start + clip.duration
      for (const w of freeze) {
        const from = Math.max(w.start, s)
        const to = Math.min(w.end, e)
        if (to - from < minPiece) continue
        if (from - s >= minPiece) {
          const frozen = id(`freeze:${clip.id}:${round(from, 3)}`)
          commands.push({ type: 'clip.split', clipId: target, time: from, newClipId: frozen })
          target = frozen
        }
        let rest: string | null = null
        if (e - to >= minPiece) {
          rest = id(`freeze:${clip.id}:${round(to, 3)}`)
          commands.push({ type: 'clip.split', clipId: target, time: to, newClipId: rest })
        }
        commands.push({ type: 'clip.set', clipId: target, path: ['playbackRate'], value: 0 })
        if (!rest) break
        target = rest
        s = to
      }
    }
  }

  // Add the take's clips. A shot that continues the clip just before it (same pad, footage continuing, e.g. after
  // pausing and resuming) extends that clip instead of adding a cut.
  const cleared = applyCommands(project, commands)
  const extendable = (trackId: string, at: Seconds, pad: string) =>
    Object.values(cleared.clips).find(
      (c) =>
        c.trackId === trackId &&
        Math.abs(c.start + c.duration - at) < EPS &&
        c.meta?.vj !== undefined &&
        (c.meta.vj as JsonObject).pad === pad,
    )
  for (const lane of lanes) {
    const track = laneTracks.get(lane.key)
    if (!track) continue
    if (lane.kind === 'fx') {
      for (const hit of lane.hits) {
        commands.push({ type: 'clip.add', clip: hitClip(lane, hit, track.id, ctx) })
        summary.effects++
      }
      continue
    }
    lane.segments.forEach((seg, i) => {
      const made = lane.kind === 'clips' ? shotClips(seg, track.id, ctx) : [lookClip(seg, track.id, ctx)]
      for (const [j, clip] of made.entries()) {
        if (!clip) continue
        const previous =
          i === 0 && j === 0 && !seg.cut ? extendable(track.id, clip.start, seg.pad.id) : undefined
        const continues =
          previous &&
          (previous.type !== 'video' ||
            (clip.type === 'video' &&
              previous.playbackRate === clip.playbackRate &&
              Math.abs(previous.sourceStart + previous.duration * previous.playbackRate - clip.sourceStart) <
                0.5 / fps))
        if (previous && continues)
          commands.push({
            type: 'clip.trim',
            clipId: previous.id,
            start: previous.start,
            duration: previous.duration + clip.duration,
          })
        else commands.push({ type: 'clip.add', clip })
        if (lane.kind === 'clips') summary.clips++
        else summary.looks++
      }
    })
  }
  return { commands, lanes, summary, cursors }
}
