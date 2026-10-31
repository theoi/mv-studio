/**
 * Evaluates animatable parameters at a point in time: keyframe interpolation with easing, then audio modulation.
 * Pure and deterministic, so preview and export compute identical values for the same time.
 */
import type { Animatable, Easing, Keyframe, ParamValue } from '../model/types.ts'
import type { AudioSampler } from './audioFeatures.ts'
import { formatColor, isHexColor, parseColor } from './color.ts'

const PRESETS: Record<'ease-in' | 'ease-out' | 'ease-in-out', [number, number, number, number]> = {
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

/** CSS-style cubic-bezier timing function: solves x(s) = t for s, returns y(s). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let s = t
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - t
      if (Math.abs(err) < 1e-6) return sampleY(s)
      const d = slopeX(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = t
    for (let i = 0; i < 30; i++) {
      const x = sampleX(s)
      if (Math.abs(x - t) < 1e-6) break
      if (x < t) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return sampleY(s)
  }
}

const presetFns = {
  'ease-in': cubicBezier(...PRESETS['ease-in']),
  'ease-out': cubicBezier(...PRESETS['ease-out']),
  'ease-in-out': cubicBezier(...PRESETS['ease-in-out']),
}
const customCache = new Map<string, (t: number) => number>()

/** Maps linear progress t (0..1) through an easing. 'hold' keeps the start value until the next keyframe. */
export function ease(easing: Easing, t: number): number {
  if (typeof easing === 'string') {
    if (easing === 'linear') return t
    if (easing === 'hold') return t >= 1 ? 1 : 0
    return presetFns[easing](t)
  }
  const key = `${easing.x1},${easing.y1},${easing.x2},${easing.y2}`
  let fn = customCache.get(key)
  if (!fn) {
    fn = cubicBezier(easing.x1, easing.y1, easing.x2, easing.y2)
    customCache.set(key, fn)
  }
  return fn(t)
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Interpolates between two values of the same kind. Non-numeric values (other than colors) step at t = 1. */
export function interpolate<T extends ParamValue>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t) as T
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
    return a.map((v, i) => lerp(v, b[i] as number, t)) as T
  if (isHexColor(a) && isHexColor(b)) {
    const ca = parseColor(a)
    const cb = parseColor(b)
    return formatColor([
      lerp(ca[0], cb[0], t),
      lerp(ca[1], cb[1], t),
      lerp(ca[2], cb[2], t),
      lerp(ca[3], cb[3], t),
    ]) as T
  }
  return t >= 1 ? b : a
}

/** Value of a keyframe track at `time` (seconds from the clip start). Assumes keyframes sorted by time. */
export function sampleKeyframes<T extends ParamValue>(keys: readonly Keyframe<T>[], time: number): T {
  const first = keys[0] as Keyframe<T>
  if (keys.length === 1 || time <= first.time) return first.value
  const last = keys[keys.length - 1] as Keyframe<T>
  if (time >= last.time) return last.value
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((keys[mid] as Keyframe<T>).time <= time) lo = mid
    else hi = mid
  }
  const k0 = keys[lo] as Keyframe<T>
  const k1 = keys[hi] as Keyframe<T>
  const span = k1.time - k0.time
  const t = span > 0 ? (time - k0.time) / span : 1
  return interpolate(k0.value, k1.value, ease(k0.easing, t))
}

/** Keyframed value without audio modulation. */
export function evaluate<T extends ParamValue>(anim: Animatable<T>, localTime: number): T {
  return anim.keyframes && anim.keyframes.length > 0 ? sampleKeyframes(anim.keyframes, localTime) : anim.value
}

/**
 * Numeric value with keyframes and audio modulation applied. `time` is the absolute timeline time used to look up
 * audio features; `localTime` is relative to the clip start.
 */
export function evaluateNumber(
  anim: Animatable<number>,
  localTime: number,
  time: number,
  audio?: AudioSampler,
): number {
  let value = evaluate(anim, localTime)
  if (!anim.modulation || !audio) return value
  for (const mod of anim.modulation) {
    const feature = audio.sample(mod.source, time, mod.smoothing, mod.audioAssetId)
    value = mod.mode === 'add' ? value + feature * mod.amount : value * (1 + feature * mod.amount)
  }
  return value
}

/** Evaluates any parameter; numbers also get audio modulation. */
export function evaluateParam(
  anim: Animatable<ParamValue>,
  localTime: number,
  time: number,
  audio?: AudioSampler,
): ParamValue {
  const base = evaluate(anim, localTime)
  return typeof base === 'number' ? evaluateNumber(anim as Animatable<number>, localTime, time, audio) : base
}
