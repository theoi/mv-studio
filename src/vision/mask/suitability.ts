import type { Mask, Rect, SuitabilityReason, SuitabilityReport, TimeRange } from '../types.ts'
import { components, coverage } from './ops.ts'

export interface SuitabilityOptions {
  /** Largest subject must cover at least this fraction of the frame. */
  minSubjectFraction?: number
  /** Largest subject's box must be at least this tall (fraction of frame height). */
  minSubjectHeight?: number
  /** Total coverage above this leaves no visible background for text. */
  maxCoverage?: number
  /** Below this total coverage the frame counts as having no subject. */
  noSubjectCoverage?: number
  /** Minimum usable fraction of sampled frames for a 'good' verdict. */
  goodFraction?: number
  /** Minimum usable fraction for 'marginal' (offered on suitable ranges only). */
  marginalFraction?: number
  /**
   * Stability (the share of frames without a visible pop, `POP_MIN_SHARE`) below this marks the mask unstable: a pop in
   * more than one frame in ten. Measured only on the person track, which keeps each frame's pop share.
   */
  minStability?: number
  /** Ranges shorter than this (seconds) are dropped. */
  minRangeSeconds?: number
}

const DEFAULTS: Required<SuitabilityOptions> = {
  minSubjectFraction: 0.03,
  minSubjectHeight: 0.3,
  maxCoverage: 0.75,
  noSubjectCoverage: 0.004,
  goodFraction: 0.7,
  marginalFraction: 0.25,
  minStability: 0.9,
  minRangeSeconds: 1,
}

type FrameVerdict = 'ok' | SuitabilityReason

export interface FrameAssessment {
  t: number
  coverage: number
  verdict: FrameVerdict
}

export function assessFrame(t: number, mask: Mask, options: SuitabilityOptions = {}): FrameAssessment {
  const o = { ...DEFAULTS, ...options }
  const cov = coverage(mask)
  if (cov < o.noSubjectCoverage) return { t, coverage: cov, verdict: 'no-subject' }
  if (cov > o.maxCoverage) return { t, coverage: cov, verdict: 'subject-fills-frame' }
  const { components: comps } = components(mask)
  const largest = comps[0]
  if (!largest || largest.fraction < o.minSubjectFraction || largest.box.height < o.minSubjectHeight) {
    const smallOnes = comps.filter((c) => c.fraction >= o.minSubjectFraction / 8).length
    return { t, coverage: cov, verdict: smallOnes >= 3 ? 'many-small-subjects' : 'subject-too-small' }
  }
  return { t, coverage: cov, verdict: 'ok' }
}

/** Bumped whenever the verdict for the same masks changes, so stored reports are judged again. */
export const SUITABILITY_VERSION = 4

/**
 * The person segmenter also cuts out animals and some vehicles, so the verdict counts only the mask inside boxes an
 * object detector labels "person". These were chosen on the 65-clip dev set (see src/vision/README.md).
 */
export const PERSON_MIN_SCORE = 0.3
/** Shortest `personHold`, in seconds. */
export const PERSON_HOLD_SECONDS = 0.5
/** Each side of a person box grows by this share of its size, for hair, raised arms and loose clothes. */
export const PERSON_BOX_MARGIN = 0.15

/** People found in one frame (boxes normalized to the frame). */
export interface PeopleAt {
  t: number
  boxes: Rect[]
}

/**
 * How far detections may be on each side of a frame for it to keep their boxes: 2.5 times the usual interval between
 * detections, at least `PERSON_HOLD_SECONDS`. A hold in seconds alone would depend on the rate: the track detects
 * every 5 frames (0.208 s at 24 fps, so two misses in a row leave the nearest hit 0.417 s away), and a long shot's
 * quick check samples further apart.
 */
export function personHold(people: ReadonlyArray<PeopleAt>): number {
  const times = people.map((p) => p.t).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++)
    if (times[i]! - times[i - 1]! > 1e-6) gaps.push(times[i]! - times[i - 1]!)
  if (!gaps.length) return PERSON_HOLD_SECONDS
  gaps.sort((a, b) => a - b)
  return Math.max(PERSON_HOLD_SECONDS, 2.5 * gaps[gaps.length >> 1]!)
}

/**
 * Boxes of the people found around `t`, when someone was found within `hold` seconds both before and after it (one
 * side is enough within `hold` of the first or last frame looked at). This bridges a person the detector misses up to
 * twice in a row, but a stray hit (an animal it takes for a person now and then) covers only its own frame instead of
 * spreading over the shot.
 */
export function peopleNear(people: ReadonlyArray<PeopleAt>, t: number, hold = personHold(people)): Rect[] {
  return peopleIndex(people, hold)(t)
}

/** `peopleNear` for many times: sorts the detections once, so each lookup is a binary search plus the hold window. */
export function peopleIndex(
  people: ReadonlyArray<PeopleAt>,
  hold = personHold(people),
): (t: number) => Rect[] {
  const eps = 1e-6
  const hits = people.filter((p) => p.boxes.length).sort((a, b) => a.t - b.t)
  let first = Infinity
  let last = -Infinity
  for (const p of people) {
    first = Math.min(first, p.t)
    last = Math.max(last, p.t)
  }
  return (t) => {
    let lo = 0
    let hi = hits.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (hits[mid]!.t < t - hold - eps) lo = mid + 1
      else hi = mid
    }
    let end = lo
    while (end < hits.length && hits[end]!.t <= t + hold + eps) end++
    if (end === lo) return []
    const before = hits[lo]!.t <= t + eps || t - first <= hold + eps
    const after = hits[end - 1]!.t >= t - eps || last - t <= hold + eps
    return before && after ? hits.slice(lo, end).flatMap((p) => p.boxes) : []
  }
}

/** The mask with everything outside the (grown) boxes cleared. */
export function keepPeople(mask: Mask, boxes: ReadonlyArray<Rect>, margin = PERSON_BOX_MARGIN): Mask {
  const { width: w, height: h } = mask
  const data = new Uint8Array(w * h)
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor((b.x - b.width * margin) * w))
    const x1 = Math.min(w, Math.ceil((b.x + b.width * (1 + margin)) * w))
    const y0 = Math.max(0, Math.floor((b.y - b.height * margin) * h))
    const y1 = Math.min(h, Math.ceil((b.y + b.height * (1 + margin)) * h))
    for (let y = y0; y < y1; y++) data.set(mask.data.subarray(y * w + x0, y * w + x1), y * w + x0)
  }
  return { width: w, height: h, data }
}

export interface SuitabilitySample {
  t: number
  mask: Mask
}

/**
 * A frame pops visibly when at least this share of the subject switches off and back on, or on and off, in blocks the
 * pop meter keeps (`mask/pops.ts`, which drops thin outline shimmer). On the dev set's person tracks, such pops of 5 %
 * or more are a leg, a patch of floor or wall, or a bystander blinking.
 */
export const POP_MIN_SHARE = 0.05

/**
 * Decides whether "text behind the subject" works for a shot, from masks sampled across it (ascending times). The
 * quick check and the stored person track both judge with this, so they agree on the same masks. `spacing` is the
 * nominal time between samples, used to turn usable samples into time ranges. Stability is the share of frames without
 * a visible pop, from the person track's per-frame `pops` (every frame, not just the samples); the quick check has
 * none and reports null. With `people`, each frame is judged only on its mask inside the people found near it
 * (`peopleNear`); flicker is still measured on the whole mask, since the export cuts out all of it.
 */
export function assessSuitability(
  samples: ReadonlyArray<SuitabilitySample>,
  spacing: number,
  options: SuitabilityOptions = {},
  people?: ReadonlyArray<PeopleAt>,
  pops?: ReadonlyArray<number>,
): SuitabilityReport {
  const o = { ...DEFAULTS, ...options }
  const near = people && peopleIndex(people)
  const frames = samples.map((s) => assessFrame(s.t, near ? keepPeople(s.mask, near(s.t)) : s.mask, o))
  const n = frames.length
  if (n === 0) {
    return {
      verdict: 'unsuitable',
      reasons: ['no-subject'],
      usableFraction: 0,
      meanCoverage: 0,
      stability: null,
      sampledFrames: 0,
      suitableRanges: [],
    }
  }
  const usable = frames.filter((f) => f.verdict === 'ok').length
  const usableFraction = usable / n
  const meanCoverage = frames.reduce((a, f) => a + f.coverage, 0) / n

  const stability = pops?.length ? 1 - pops.filter((p) => p >= POP_MIN_SHARE).length / pops.length : null

  const counts = new Map<SuitabilityReason, number>()
  for (const f of frames) if (f.verdict !== 'ok') counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1)
  const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
  const unstable = stability !== null && stability < o.minStability
  // When flicker is all that keeps the shot from good, it comes first: the few frames without a usable person are not
  // why the shot is marginal.
  if (unstable && usableFraction >= o.goodFraction) reasons.unshift('unstable-mask')
  else if (unstable) reasons.push('unstable-mask')

  const suitableRanges = usableRanges(frames, spacing, o.minRangeSeconds)
  let verdict: SuitabilityReport['verdict'] = 'unsuitable'
  if (usableFraction >= o.goodFraction && !unstable) verdict = 'good'
  else if (usableFraction >= o.marginalFraction && suitableRanges.length > 0) verdict = 'marginal'

  return {
    verdict,
    reasons: verdict === 'good' ? [] : reasons,
    usableFraction,
    meanCoverage,
    stability,
    sampledFrames: n,
    suitableRanges: verdict === 'unsuitable' ? [] : suitableRanges,
  }
}

function usableRanges(frames: FrameAssessment[], spacing: number, minSeconds: number): TimeRange[] {
  const ranges: TimeRange[] = []
  let start: number | null = null
  let end = 0
  for (const f of frames) {
    if (f.verdict === 'ok') {
      if (start === null) start = Math.max(0, f.t - spacing / 2)
      end = f.t + spacing / 2
    } else if (start !== null) {
      ranges.push({ start, end })
      start = null
    }
  }
  if (start !== null) ranges.push({ start, end })
  return ranges.filter((r) => r.end - r.start >= minSeconds - 1e-9)
}
