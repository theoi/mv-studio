import type {
  CropKeyframe,
  Rect,
  ReframeAspect,
  ReframePlan,
  Size,
  SubjectSample,
  SubjectTrack,
} from '../types.ts'

export interface ReframeOptions {
  /** >= 1, default 1. */
  zoom?: number
  /** Fraction of the crop size around the camera centre where subject movement does not move the camera, default 0.12. */
  deadZone?: number
  /** Max camera speed in crop-widths (crop-heights vertically) per second, default 0.6. */
  maxSpeed?: number
  /** 0..1 camera easing, default 0.85. Higher is smoother and slower to react. */
  smoothing?: number
  /** Times where the camera may jump instantly (shot changes). */
  cuts?: number[]
  /** Keyframe simplification tolerance in normalized units, default 0.004. */
  tolerance?: number
  /** Try to keep the whole subject box inside the crop, default true. */
  keepBox?: boolean
}

const ASPECTS: Record<ReframeAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 }
const EPS = 1e-9
/** `smoothing` is defined per frame at this rate so easing does not depend on the sample rate. */
const EASING_FPS = 30

export function baseCropSize(source: Size, aspect: ReframeAspect): { width: number; height: number } {
  const sourceAspect = source.width / source.height
  const target = ASPECTS[aspect]
  if (Math.abs(target - sourceAspect) < EPS) return { width: 1, height: 1 }
  if (target < sourceAspect) return { width: target / sourceAspect, height: 1 }
  return { width: 1, height: sourceAspect / target }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Keeps a crop of `size` (normalized) inside 0..1; a full-span axis stays centred. */
function clampCentre(c: number, size: number): number {
  if (size >= 1 - EPS) return 0.5
  return clamp(c, size / 2, 1 - size / 2)
}

/** Minimal shift of `c` so the span [lo, lo+len] fits inside a crop of `size` centred at `c`. */
function containSpan(c: number, size: number, lo: number, len: number): number {
  if (len > size) return c
  if (lo < c - size / 2) return lo + size / 2
  if (lo + len > c + size / 2) return lo + len - size / 2
  return c
}

function desiredCentre(s: SubjectSample, w: number, h: number, keepBox: boolean): { x: number; y: number } {
  let { x, y } = s.focus
  if (keepBox && s.box && s.box.width <= w && s.box.height <= h) {
    x = containSpan(x, w, s.box.x, s.box.width)
    y = containSpan(y, h, s.box.y, s.box.height)
  }
  return { x: clampCentre(x, w), y: clampCentre(y, h) }
}

interface AxisParams {
  size: number
  deadHalf: number
  maxStep: number
  ease: number
}

function stepAxis(cam: number, desired: number, p: AxisParams): number {
  const offset = desired - cam
  if (Math.abs(offset) <= p.deadHalf) return cam
  const target = desired - Math.sign(offset) * p.deadHalf
  const move = clamp((target - cam) * p.ease, -p.maxStep, p.maxStep)
  return clampCentre(cam + move, p.size)
}

interface DensePoint {
  t: number
  cx: number
  cy: number
}

/** Index of the first sample of each new shot (a cut lies in (t[i-1], t[i]]). */
function cutStarts(samples: SubjectSample[], cuts: number[]): Set<number> {
  const starts = new Set<number>()
  for (const c of cuts) {
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]
      const cur = samples[i]
      if (prev && cur && prev.t < c && cur.t >= c) {
        starts.add(i)
        break
      }
    }
  }
  return starts
}

function simulateCamera(
  samples: SubjectSample[],
  w: number,
  h: number,
  starts: Set<number>,
  opts: Required<Omit<ReframeOptions, 'cuts' | 'tolerance' | 'zoom'>>,
): DensePoint[] {
  const path: DensePoint[] = []
  let cam = { x: 0.5, y: 0.5 }
  samples.forEach((s, i) => {
    const desired = desiredCentre(s, w, h, opts.keepBox)
    const prev = samples[i - 1]
    if (!prev || starts.has(i)) {
      cam = desired
    } else {
      const dt = Math.max(0, s.t - prev.t)
      const ease = 1 - Math.pow(clamp(opts.smoothing, 0, 1), dt * EASING_FPS)
      cam = {
        x: stepAxis(cam.x, desired.x, {
          size: w,
          deadHalf: (opts.deadZone * w) / 2,
          maxStep: opts.maxSpeed * w * dt,
          ease,
        }),
        y: stepAxis(cam.y, desired.y, {
          size: h,
          deadHalf: (opts.deadZone * h) / 2,
          maxStep: opts.maxSpeed * h * dt,
          ease,
        }),
      }
    }
    path.push({ t: s.t, cx: cam.x, cy: cam.y })
  })
  return path
}

function deviation(p: DensePoint, a: DensePoint, b: DensePoint): number {
  const span = b.t - a.t
  const w = span > 0 ? (p.t - a.t) / span : 0
  return Math.max(Math.abs(p.cx - (a.cx + (b.cx - a.cx) * w)), Math.abs(p.cy - (a.cy + (b.cy - a.cy) * w)))
}

/** Ramer–Douglas–Peucker on [first, last]; marks kept indices. Iterative to avoid deep recursion on long clips. */
function simplifyRange(
  path: DensePoint[],
  first: number,
  last: number,
  tolerance: number,
  keep: boolean[],
): void {
  keep[first] = true
  keep[last] = true
  const stack: [number, number][] = [[first, last]]
  for (let range = stack.pop(); range; range = stack.pop()) {
    const [lo, hi] = range
    const a = path[lo]
    const b = path[hi]
    if (!a || !b || hi - lo < 2) continue
    let worst = -1
    let worstDev = tolerance
    for (let i = lo + 1; i < hi; i++) {
      const p = path[i]
      if (!p) continue
      const d = deviation(p, a, b)
      if (d > worstDev) {
        worstDev = d
        worst = i
      }
    }
    if (worst < 0) continue
    keep[worst] = true
    stack.push([lo, worst], [worst, hi])
  }
}

function simplify(path: DensePoint[], starts: Set<number>, tolerance: number): DensePoint[] {
  if (path.length <= 1) return [...path]
  const keep = path.map(() => false)
  const bounds = [0, ...[...starts].sort((a, b) => a - b), path.length]
  for (let k = 0; k + 1 < bounds.length; k++) {
    const lo = bounds[k] ?? 0
    const hi = (bounds[k + 1] ?? path.length) - 1
    simplifyRange(path, lo, hi, tolerance, keep)
  }
  return path.filter((_, i) => keep[i])
}

export function planReframe(
  track: SubjectTrack,
  aspect: ReframeAspect,
  opts: ReframeOptions = {},
): ReframePlan {
  const zoom = Math.max(1, opts.zoom ?? 1)
  const baseCrop = baseCropSize(track.sourceSize, aspect)
  const w = baseCrop.width / zoom
  const h = baseCrop.height / zoom
  const samples = [...track.samples].sort((a, b) => a.t - b.t)
  const starts = cutStarts(samples, opts.cuts ?? [])

  const path = simulateCamera(samples, w, h, starts, {
    deadZone: opts.deadZone ?? 0.12,
    maxSpeed: opts.maxSpeed ?? 0.6,
    smoothing: opts.smoothing ?? 0.85,
    keepBox: opts.keepBox ?? true,
  })
  const points = path.length > 0 ? path : [{ t: 0, cx: 0.5, cy: 0.5 }]
  const keyframes: CropKeyframe[] = simplify(points, starts, opts.tolerance ?? 0.004).map((p) => ({
    t: p.t,
    cx: p.cx,
    cy: p.cy,
    zoom,
  }))

  return {
    version: 1,
    mediaId: track.mediaId,
    aspect,
    sourceSize: { ...track.sourceSize },
    baseCrop,
    keyframes,
  }
}

function interpolate(keyframes: CropKeyframe[], t: number): { cx: number; cy: number; zoom: number } {
  const first = keyframes[0]
  const last = keyframes[keyframes.length - 1]
  if (!first || !last) return { cx: 0.5, cy: 0.5, zoom: 1 }
  if (t <= first.t) return first
  if (t >= last.t) return last
  let lo = 0
  let hi = keyframes.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((keyframes[mid]?.t ?? 0) <= t) lo = mid
    else hi = mid
  }
  const a = keyframes[lo] ?? first
  const b = keyframes[hi] ?? last
  const span = b.t - a.t
  const w = span > 0 ? (t - a.t) / span : 0
  return { cx: a.cx + (b.cx - a.cx) * w, cy: a.cy + (b.cy - a.cy) * w, zoom: a.zoom + (b.zoom - a.zoom) * w }
}

export function cropAt(plan: ReframePlan, t: number): Rect {
  const k = interpolate(plan.keyframes, t)
  const zoom = Math.max(1, k.zoom)
  const width = Math.min(1, plan.baseCrop.width / zoom)
  const height = Math.min(1, plan.baseCrop.height / zoom)
  const cx = clampCentre(k.cx, width)
  const cy = clampCentre(k.cy, height)
  return { x: clamp(cx - width / 2, 0, 1 - width), y: clamp(cy - height / 2, 0, 1 - height), width, height }
}
