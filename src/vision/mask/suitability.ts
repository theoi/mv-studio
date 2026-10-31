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
  /** Stability below this marks the mask unstable. Measured only on samples that come with their neighbouring frames. */
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
  minStability: 0.8,
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
export const SUITABILITY_VERSION = 3

/**
 * The person segmenter also cuts out animals and some vehicles, so the verdict counts only the mask inside boxes an
 * object detector labels "person". These were chosen on the 65-clip dev set (see src/vision/README.md).
 */
export const PERSON_MIN_SCORE = 0.3
/** A frame uses the people found within this many seconds of it, so a person the detector misses for a frame or two stays. */
export const PERSON_HOLD_SECONDS = 0.4
/** Each side of a person box grows by this share of its size, for hair, raised arms and loose clothes. */
export const PERSON_BOX_MARGIN = 0.15

/** People found in one frame (boxes normalized to the frame). */
export interface PeopleAt {
  t: number
  boxes: Rect[]
}

/** Boxes of the people found within `hold` seconds of `t`. */
export function peopleNear(people: ReadonlyArray<PeopleAt>, t: number, hold = PERSON_HOLD_SECONDS): Rect[] {
  return people.filter((p) => Math.abs(p.t - t) <= hold + 1e-6).flatMap((p) => p.boxes)
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

/** A sampled mask, optionally with the frames just before and after it (needed to measure flicker). */
export interface SuitabilitySample {
  t: number
  mask: Mask
  prev?: Mask
  next?: Mask
}

/**
 * Share of the subject that flickers at the middle of three consecutive frames: pixels on in the middle frame and
 * off in both neighbours, or the other way round. A subject that moves smoothly changes each edge pixel once, so
 * movement does not count, only a mask that jumps back and forth.
 */
export function flicker(prev: Mask, cur: Mask, next: Mask, threshold = 128): number {
  let flips = 0
  let area = 0
  for (let i = 0; i < cur.data.length; i++) {
    const a = prev.data[i]! >= threshold
    const b = cur.data[i]! >= threshold
    const c = next.data[i]! >= threshold
    if (a || b || c) area++
    if (a === c && a !== b) flips++
  }
  return area ? flips / area : 0
}

/**
 * Decides whether "text behind the subject" works for a shot, from masks sampled across it (ascending times). The
 * quick check and the stored person track both judge with this, so they agree on the same masks. `spacing` is the
 * nominal time between samples, used to turn usable samples into time ranges. Stability is measured on the samples
 * that come with their neighbouring frames (the person track), and is null without them (the quick check). With
 * `people`, each frame is judged only on its mask inside the people found near it (`peopleNear`); flicker is still
 * measured on the whole mask, since the export cuts out all of it.
 */
export function assessSuitability(
  samples: ReadonlyArray<SuitabilitySample>,
  spacing: number,
  options: SuitabilityOptions = {},
  people?: ReadonlyArray<PeopleAt>,
): SuitabilityReport {
  const o = { ...DEFAULTS, ...options }
  const frames = samples.map((s) =>
    assessFrame(s.t, people ? keepPeople(s.mask, peopleNear(people, s.t)) : s.mask, o),
  )
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

  let stability: number | null = null
  const triples = samples.filter((s) => s.prev && s.next)
  if (triples.length >= 3)
    stability = 1 - triples.reduce((a, s) => a + flicker(s.prev!, s.mask, s.next!), 0) / triples.length

  const counts = new Map<SuitabilityReason, number>()
  for (const f of frames) if (f.verdict !== 'ok') counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1)
  const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
  const unstable = stability !== null && stability < o.minStability
  if (unstable) reasons.push('unstable-mask')

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
