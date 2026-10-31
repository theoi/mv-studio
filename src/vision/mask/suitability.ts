import type { Mask, SuitabilityReason, SuitabilityReport, TimeRange } from '../types.ts'
import { centroid, components, coverage, iou, shiftMask } from './ops.ts'

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
  /** Mean consecutive IoU below this marks the mask unstable (only for dense samples). */
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

/**
 * Decides whether "text behind the subject" works for a shot, from masks sampled across
 * it (ascending times). `spacing` is the nominal time between samples, used to turn
 * usable samples into time ranges and to judge whether stability can be measured.
 */
export function assessSuitability(
  samples: ReadonlyArray<{ t: number; mask: Mask }>,
  spacing: number,
  options: SuitabilityOptions = {},
): SuitabilityReport {
  const o = { ...DEFAULTS, ...options }
  const frames = samples.map((s) => assessFrame(s.t, s.mask, o))
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
  if (n >= 3 && spacing <= 0.2) {
    let s = 0
    for (let i = 1; i < n; i++) s += alignedIou(samples[i - 1]!.mask, samples[i]!.mask)
    stability = s / (n - 1)
  }

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

/** IoU after aligning centroids, so a subject moving across the frame doesn't read as flicker. */
function alignedIou(a: Mask, b: Mask): number {
  const ca = centroid(a)
  const cb = centroid(b)
  if (!ca || !cb) return iou(a, b)
  return iou(shiftMask(a, Math.round((cb.x - ca.x) * a.width), Math.round((cb.y - ca.y) * a.height)), b)
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
