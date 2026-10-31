import type { Point, Rect, Size, SubjectSample, SubjectTrack } from '../types.ts'

/** Normalized 0..1 source coordinates. */
export interface FaceObservation {
  box: Rect
  score: number
}

export interface FrameObservation {
  t: number
  faces: FaceObservation[]
  personBox: Rect | null
  /** Fraction of the frame covered by the person mask, 0..1. */
  personCoverage: number
  selectionBox?: Rect | null
}

const MIN_FACE_SCORE = 0.5
const MIN_PERSON_COVERAGE = 0.005
/** Where the head / upper body sits inside a person box, as a fraction of its height. */
const PERSON_FOCUS_Y = 0.22
const MEDIAN_WINDOW = 5

const CENTRE: Point = { x: 0.5, y: 0.5 }

function centreOf(box: Rect): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function unionRects(rects: Rect[]): Rect | null {
  const first = rects[0]
  if (!first) return null
  let x0 = first.x
  let y0 = first.y
  let x1 = first.x + first.width
  let y1 = first.y + first.height
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export function subjectFromObservation(obs: FrameObservation): SubjectSample {
  const { t } = obs
  if (obs.selectionBox) {
    return {
      t,
      focus: centreOf(obs.selectionBox),
      box: { ...obs.selectionBox },
      confidence: 1,
      source: 'selection',
    }
  }

  const faces = obs.faces.filter((f) => f.score >= MIN_FACE_SCORE)
  let best: FaceObservation | undefined
  for (const face of faces) {
    const weight = face.box.width * face.box.height * face.score
    if (!best || weight > best.box.width * best.box.height * best.score) best = face
  }
  if (best) {
    const parts = faces.map((f) => f.box)
    if (obs.personBox) parts.push(obs.personBox)
    return {
      t,
      focus: centreOf(best.box),
      box: unionRects(parts),
      confidence: clamp01(best.score),
      source: 'face',
    }
  }

  if (obs.personBox && obs.personCoverage >= MIN_PERSON_COVERAGE) {
    const b = obs.personBox
    return {
      t,
      focus: { x: b.x + b.width / 2, y: b.y + PERSON_FOCUS_Y * b.height },
      box: { ...b },
      confidence: Math.min(1, obs.personCoverage * 10),
      source: 'person',
    }
  }

  return { t, focus: { ...CENTRE }, box: null, confidence: 0, source: 'none' }
}

export function buildSubjectTrack(
  mediaId: string,
  sourceSize: Size,
  observations: FrameObservation[],
): SubjectTrack {
  const samples = observations.map(subjectFromObservation).sort((a, b) => a.t - b.t)
  return { version: 1, mediaId, sourceSize: { ...sourceSize }, samples }
}

// ---------------------------------------------------------------------------
// Offline smoothing

function lerp(a: number, b: number, w: number): number {
  return a + (b - a) * w
}

function lerpRect(a: Rect | null, b: Rect | null, w: number): Rect | null {
  if (!a || !b) return a ? { ...a } : b ? { ...b } : null
  return {
    x: lerp(a.x, b.x, w),
    y: lerp(a.y, b.y, w),
    width: lerp(a.width, b.width, w),
    height: lerp(a.height, b.height, w),
  }
}

interface Frame {
  focus: Point
  box: Rect | null
}

function fillGaps(samples: SubjectSample[], holdSeconds: number): Frame[] {
  const known = samples.flatMap((s, i) => (s.source === 'none' ? [] : [i]))
  if (known.length === 0) return samples.map(() => ({ focus: { ...CENTRE }, box: null }))

  const frames: Frame[] = []
  let prev = -1
  let next = 0
  samples.forEach((s, i) => {
    if (s.source !== 'none') {
      prev = i
      next++
      frames.push({ focus: { ...s.focus }, box: s.box ? { ...s.box } : null })
      return
    }
    const p = prev >= 0 ? samples[prev] : undefined
    const nIdx = known[next]
    const n = nIdx === undefined ? undefined : samples[nIdx]
    if (!p) {
      // Leading gap: there is always a following known sample here because known is non-empty.
      const src = n ?? s
      frames.push({ focus: { ...src.focus }, box: src.box ? { ...src.box } : null })
      return
    }
    const easeStart = p.t + holdSeconds
    if (!n || s.t <= easeStart || n.t <= easeStart) {
      frames.push({ focus: { ...p.focus }, box: p.box ? { ...p.box } : null })
      return
    }
    const w = (s.t - easeStart) / (n.t - easeStart)
    frames.push({
      focus: { x: lerp(p.focus.x, n.focus.x, w), y: lerp(p.focus.y, n.focus.y, w) },
      box: lerpRect(p.box, n.box, w),
    })
  })
  return frames
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function medianFilter(values: number[], window: number): number[] {
  const half = Math.floor(window / 2)
  return values.map((_, i) => median(values.slice(Math.max(0, i - half), i + half + 1)))
}

/** Gaussian smoothing over non-uniform timestamps; `null` entries are skipped and stay null. */
function gaussian(times: number[], values: (number | null)[], sigma: number): (number | null)[] {
  if (sigma <= 0) return [...values]
  const reach = 3 * sigma
  const inv = 1 / (2 * sigma * sigma)
  return values.map((v, i) => {
    if (v === null) return null
    const ti = times[i] ?? 0
    let sum = 0
    let wsum = 0
    for (let j = i; j >= 0 && ti - (times[j] ?? 0) <= reach; j--) {
      const vj = values[j]
      if (vj === null || vj === undefined) continue
      const d = ti - (times[j] ?? 0)
      const w = Math.exp(-d * d * inv)
      sum += w * vj
      wsum += w
    }
    for (let j = i + 1; j < values.length && (times[j] ?? 0) - ti <= reach; j++) {
      const vj = values[j]
      if (vj === null || vj === undefined) continue
      const d = (times[j] ?? 0) - ti
      const w = Math.exp(-d * d * inv)
      sum += w * vj
      wsum += w
    }
    return wsum > 0 ? sum / wsum : v
  })
}

export function smoothSubjectTrack(
  track: SubjectTrack,
  opts: { sigmaSeconds?: number; holdSeconds?: number } = {},
): SubjectTrack {
  const sigma = opts.sigmaSeconds ?? 0.25
  const hold = opts.holdSeconds ?? 1.0
  const samples = [...track.samples].sort((a, b) => a.t - b.t)
  const frames = fillGaps(samples, hold)
  const times = samples.map((s) => s.t)

  const fx = gaussian(
    times,
    medianFilter(
      frames.map((f) => f.focus.x),
      MEDIAN_WINDOW,
    ),
    sigma,
  )
  const fy = gaussian(
    times,
    medianFilter(
      frames.map((f) => f.focus.y),
      MEDIAN_WINDOW,
    ),
    sigma,
  )
  const boxChannel = (pick: (r: Rect) => number) =>
    gaussian(
      times,
      frames.map((f) => (f.box ? pick(f.box) : null)),
      sigma,
    )
  const bx = boxChannel((r) => r.x)
  const by = boxChannel((r) => r.y)
  const bw = boxChannel((r) => r.width)
  const bh = boxChannel((r) => r.height)

  const smoothed = samples.map((s, i): SubjectSample => {
    const x = bx[i]
    const y = by[i]
    const w = bw[i]
    const h = bh[i]
    const box = x != null && y != null && w != null && h != null ? { x, y, width: w, height: h } : null
    return {
      t: s.t,
      focus: { x: fx[i] ?? 0.5, y: fy[i] ?? 0.5 },
      box,
      confidence: s.confidence,
      source: s.source,
    }
  })
  return { ...track, sourceSize: { ...track.sourceSize }, samples: smoothed }
}
