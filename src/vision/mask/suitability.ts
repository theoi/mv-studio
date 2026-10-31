import type {
  Mask,
  Rect,
  SuitabilityEvidence,
  SuitabilityFrameVerdict,
  SuitabilityReason,
  SuitabilityReport,
  TimeRange,
} from '../types.ts'
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
  /** Person boxes count from this detector score, default `PERSON_MIN_SCORE`. */
  minPersonScore?: number
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
  minPersonScore: 0.3,
}

export interface FrameAssessment {
  t: number
  coverage: number
  verdict: SuitabilityFrameVerdict
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
 * Bumped whenever the verdict for the same masks changes, or the report gains what the app needs, so stored reports
 * are judged again.
 */
export const SUITABILITY_VERSION = 7
/**
 * The first `SUITABILITY_VERSION` whose stored people come from the current detection (with the animals found along
 * with them). People stored by an older version are detected again.
 */
export const PEOPLE_VERSION = 6

/**
 * The person segmenter also cuts out animals and some vehicles, so the verdict counts only the mask inside boxes an
 * object detector labels "person". These were chosen on the 65-clip dev set (see src/vision/README.md).
 */
export const PERSON_MIN_SCORE = DEFAULTS.minPersonScore
/**
 * The detector keeps boxes down to this score and each box's score is stored, so a limit between this and
 * `PERSON_MIN_SCORE` can be tried on stored tracks without detecting again.
 */
export const DETECTOR_MIN_SCORE = 0.2
/** Shortest `personHold`, in seconds. */
export const PERSON_HOLD_SECONDS = 0.5
/**
 * A "person" box counts only while the detector calls the same object (boxes overlapping by an IoU of 0.5 or more) a
 * person at least as often as an animal within this many seconds of it. The detector's classes share one non-max
 * suppression, so it names each object once per frame: a cat it takes for a person now and then is a cat in its other
 * frames, never a cat box beside the person box. Chosen on the dev set (see src/vision/README.md): over 1 s, a
 * guitarist's run of "animal" frames outvoted him.
 */
export const ANIMAL_VOTE_SECONDS = 3
const ANIMAL_VOTE_IOU = 0.5
/** A long shot's quick check samples further apart, so the vote spans at least this many detection intervals. */
const ANIMAL_VOTE_INTERVALS = 15
/** Each side of a person box grows by this share of its size, for hair, raised arms and loose clothes. */
export const PERSON_BOX_MARGIN = 0.15

/**
 * The cutout keeps the parts of the person mask near the people found (`keepPersonParts`), with boxes held this long
 * (`peopleIndex`): longer than the verdict's `personHold`, since a person missing from the cutout for a moment pops
 * in front of the text. On the dev set's tracks (65 clips, not in the repository), 0.5 s dropped an interviewee for
 * 1.6 s and 2 s alone still dropped a dancer for 4 frames.
 */
export const CUTOUT_HOLD_SECONDS = 1
/**
 * Past the hold, a frame with no one found keeps the parts that overlap the previous frame's cutout, for up to this
 * long after the last frame with people. Only in such frames: carried in every frame, a pillar that once touched a
 * person box stayed in the cutout for the rest of the shot.
 */
export const CUTOUT_CARRY_SECONDS = 2

/**
 * How far after `t` (seconds) the detections can change `peopleIndex(people, hold)` at `t`, for detections `interval`
 * seconds apart: the hold, plus the animal vote around the boxes in it.
 */
export function peopleIndexReach(hold: number, interval: number): number {
  return hold + Math.max(ANIMAL_VOTE_SECONDS, ANIMAL_VOTE_INTERVALS * interval)
}

/** People found in one frame (boxes normalized to the frame). */
export interface PeopleAt {
  t: number
  boxes: Rect[]
  /** Each box's detector score; missing in tracks stored before scores were kept, whose boxes all scored 0.3 or more. */
  scores?: number[]
  /** Animals the detector found in the frame, when any (see `animalScores`). */
  animals?: Rect[]
  animalScores?: number[]
}

/**
 * The people (and animals) in a frame's detections, with each box's score rounded down to 3 decimals: rounding to
 * nearest would store a box just under a limit (0.2995 under 0.3) at the limit, so it would count.
 */
export function detectedPeople(
  t: number,
  found: ReadonlyArray<{ box: Rect; score: number }> = [],
  animals: ReadonlyArray<{ box: Rect; score: number }> = [],
): PeopleAt {
  const score = (p: { score: number }) => Math.floor(p.score * 1000) / 1000
  return {
    t,
    boxes: found.map((p) => p.box),
    scores: found.map(score),
    ...(animals.length ? { animals: animals.map((a) => a.box), animalScores: animals.map(score) } : {}),
  }
}

/**
 * How far detections may be on each side of a frame for it to keep their boxes: 2.5 times the usual interval between
 * detections, at least `PERSON_HOLD_SECONDS`. A hold in seconds alone would depend on the rate: the track detects
 * every 5 frames (0.208 s at 24 fps, so two misses in a row leave the nearest hit 0.417 s away), and a long shot's
 * quick check samples further apart.
 */
export function personHold(people: ReadonlyArray<PeopleAt>): number {
  const interval = detectionInterval(people)
  return interval === null ? PERSON_HOLD_SECONDS : Math.max(PERSON_HOLD_SECONDS, 2.5 * interval)
}

/** The median time between detections, or null with fewer than two. */
function detectionInterval(people: ReadonlyArray<PeopleAt>): number | null {
  const times = people.map((p) => p.t).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++)
    if (times[i]! - times[i - 1]! > 1e-6) gaps.push(times[i]! - times[i - 1]!)
  if (!gaps.length) return null
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1]!
}

function boxIou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const both = w * h
  return both / (a.width * a.height + b.width * b.height - both)
}

/**
 * Whether the detector calls the object of a person box at `t` an animal more often than a person within
 * `ANIMAL_VOTE_SECONDS` (the box itself votes person).
 */
function animalVote(people: ReadonlyArray<PeopleAt>): (t: number, box: Rect) => boolean {
  if (!people.some((p) => p.animals?.length)) return () => false
  const frames = [...people].sort((a, b) => a.t - b.t)
  const interval = detectionInterval(people)
  const window =
    Math.max(ANIMAL_VOTE_SECONDS, interval === null ? 0 : ANIMAL_VOTE_INTERVALS * interval) + 1e-6
  return (t, box) => {
    let lo = 0
    let hi = frames.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid]!.t < t - window) lo = mid + 1
      else hi = mid
    }
    let votes = 0
    for (let i = lo; i < frames.length && frames[i]!.t <= t + window; i++) {
      for (const b of frames[i]!.boxes) if (boxIou(b, box) >= ANIMAL_VOTE_IOU) votes--
      for (const a of frames[i]!.animals ?? []) if (boxIou(a, box) >= ANIMAL_VOTE_IOU) votes++
    }
    return votes > 0
  }
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

/**
 * `peopleNear` for many times, counting boxes from `minScore` and leaving out those whose object the detector calls
 * an animal more often (`ANIMAL_VOTE_SECONDS`): sorts the detections once, so each lookup is a binary search plus the
 * hold window.
 */
export function peopleIndex(
  people: ReadonlyArray<PeopleAt>,
  hold = personHold(people),
  minScore = PERSON_MIN_SCORE,
): (t: number) => Rect[] {
  const eps = 1e-6
  const animal = animalVote(people)
  const hits = people
    .map((p) => ({
      t: p.t,
      boxes: p.boxes.filter((b, i) => (p.scores?.[i] ?? 1) >= minScore && !animal(p.t, b)),
    }))
    .filter((p) => p.boxes.length)
    .sort((a, b) => a.t - b.t)
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

/** The pixels of a box grown by `margin` of its size on each side, clipped to a `w` × `h` mask (end exclusive). */
function boxPixels(b: Rect, margin: number, w: number, h: number) {
  return {
    x0: Math.max(0, Math.floor((b.x - b.width * margin) * w)),
    x1: Math.min(w, Math.ceil((b.x + b.width * (1 + margin)) * w)),
    y0: Math.max(0, Math.floor((b.y - b.height * margin) * h)),
    y1: Math.min(h, Math.ceil((b.y + b.height * (1 + margin)) * h)),
  }
}

/** The mask with everything outside the (grown) boxes cleared. */
export function keepPeople(mask: Mask, boxes: ReadonlyArray<Rect>, margin = PERSON_BOX_MARGIN): Mask {
  const { width: w, height: h } = mask
  const data = new Uint8Array(w * h)
  for (const b of boxes) {
    const { x0, x1, y0, y1 } = boxPixels(b, margin, w, h)
    for (let y = y0; y < y1; y++) data.set(mask.data.subarray(y * w + x0, y * w + x1), y * w + x0)
  }
  return { width: w, height: h, data }
}

/**
 * A frame judged on its mask inside the people found near it. With no one found there although the whole mask holds a
 * shape large enough for the effect (an animal, or a person the detector missed), or held one before the cutout cut it
 * down (`largeBeforeGate`), the frame says no person was found rather than that no one is large enough: the whole mask
 * of an empty shot or of a wide shot of small people has no such shape. People found elsewhere in the frame keep it at
 * "no one large enough", since someone was found.
 */
function assessPeople(
  s: SuitabilitySample,
  boxes: ReadonlyArray<Rect>,
  o: Required<SuitabilityOptions>,
): FrameAssessment {
  const inPeople = assessFrame(s.t, keepPeople(s.mask, boxes), o)
  if (inPeople.verdict !== 'no-subject' || boxes.length) return inPeople
  return s.largeBeforeGate || holdsLargeShape(s.mask, o)
    ? { ...inPeople, verdict: 'no-person-found' }
    : inPeople
}

/** Whether a mask holds a shape large enough for the effect: one that passes the size rules, or fills the frame. */
export function holdsLargeShape(mask: Mask, options: SuitabilityOptions = {}): boolean {
  const { verdict } = assessFrame(0, mask, options)
  return verdict === 'ok' || verdict === 'subject-fills-frame'
}

/** Soft edge pixels (under 128) this close to a kept part, in pixels, stay with it. */
const PART_FRINGE = 2

/**
 * The mask with only its parts (4-connected regions of 128 and up) that reach into a (grown) person box, or that
 * overlap `carry` (the previous frame's kept mask, for frames the detector missed). A part keeps all its pixels, so
 * arms and hair outside the box stay with the person, while an animal or a patch of background apart from them goes.
 * Soft edge pixels stay within `PART_FRINGE` of a kept part. Without boxes or `carry`, the mask is cleared. When every
 * part is kept, the mask is returned as it is.
 */
export function keepPersonParts(
  mask: Mask,
  boxes: ReadonlyArray<Rect>,
  carry: Mask | null = null,
  margin = PERSON_BOX_MARGIN,
): Mask {
  const { width: w, height: h, data } = mask
  const n = w * h
  const inBoxes = new Uint8Array(n)
  for (const b of boxes) {
    const { x0, x1, y0, y1 } = boxPixels(b, margin, w, h)
    for (let y = y0; y < y1; y++) inBoxes.fill(1, y * w + x0, y * w + x1)
  }
  // In most frames the whole mask is inside the boxes, so every part is kept.
  let parts = 0
  let inside = true
  for (let i = 0; i < n; i++)
    if (data[i]! >= 128) {
      parts++
      if (!inBoxes[i]) inside = false
    }
  if (parts && inside) return mask
  // Otherwise the kept parts are flood-filled from their pixels in the boxes and under `carry`, so the parts that go
  // are never labeled.
  if (scratch?.length !== n) scratch = { kept: new Uint8Array(n), stack: new Int32Array(n), length: n }
  const { kept, stack } = scratch
  kept.fill(0)
  let top = 0
  for (let i = 0; i < n; i++)
    if (data[i]! >= 128 && (inBoxes[i] || (carry && carry.data[i]! >= 128))) {
      kept[i] = 1
      stack[top++] = i
    }
  let count = top
  while (top > 0) {
    const p = stack[--top]!
    const x = p % w
    if (x > 0 && !kept[p - 1] && data[p - 1]! >= 128) {
      kept[p - 1] = 1
      stack[top++] = p - 1
      count++
    }
    if (x < w - 1 && !kept[p + 1] && data[p + 1]! >= 128) {
      kept[p + 1] = 1
      stack[top++] = p + 1
      count++
    }
    if (p >= w && !kept[p - w] && data[p - w]! >= 128) {
      kept[p - w] = 1
      stack[top++] = p - w
      count++
    }
    if (p < n - w && !kept[p + w] && data[p + w]! >= 128) {
      kept[p + w] = 1
      stack[top++] = p + w
      count++
    }
  }
  if (parts && count === parts) return mask
  const near = grow(kept, w, h, PART_FRINGE)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (data[i]! >= 128 ? kept[i] : near[i]) out[i] = data[i]!
  return { width: w, height: h, data: out }
}

// Reused across calls (they never overlap: keepPersonParts is synchronous).
let scratch: { kept: Uint8Array; stack: Int32Array; length: number } | null = null
/** `bits` grown by `r` pixels in every direction (a square neighbourhood). */
function grow(bits: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const across = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (bits[y * w + x]) across.fill(1, y * w + Math.max(0, x - r), y * w + Math.min(w, x + r + 1))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (across[y * w + x])
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) out[yy * w + x] = 1
  return out
}

export interface SuitabilitySample {
  t: number
  mask: Mask
  /**
   * The mask was cut down to the parts near the people found (`keepPersonParts`) from one that held a shape large
   * enough for the effect, so a frame with no one near says no person was found, as on the uncut mask.
   */
  largeBeforeGate?: boolean
}

/**
 * A frame pops visibly when at least this share of the subject switches off and back on, or on and off, in blocks the
 * pop meter keeps (`mask/pops.ts`, which drops thin outline shimmer). On the dev set's person tracks, such pops of 5 %
 * or more are a leg, a patch of floor or wall, or a bystander blinking.
 */
export const POP_MIN_SHARE = 0.05

/** Every frame's pop share from the person track: `shares[i]` is for the frame at `start + i / fps` (media time). */
export interface PopSeries {
  start: number
  fps: number
  shares: ReadonlyArray<number>
}

/**
 * Decides whether "text behind the subject" works for a shot, from masks sampled across it (ascending times). The
 * quick check and the stored person track both judge with this, so they agree on the same masks. `spacing` is the
 * nominal time between samples, used to turn usable samples into time ranges. Stability is the share of frames without
 * a visible pop, from the person track's per-frame `pops` (every frame, not just the samples); the quick check has
 * none and reports null. With `people`, each frame is judged only on its mask inside the people found near it
 * (`peopleNear`); flicker is measured on the stored masks, which keep only the parts near the people
 * (`keepPersonParts`), as the export cuts them out. The report keeps its evidence, so a part of the shot can be judged
 * on its own (`suitabilityInRange`).
 */
export function assessSuitability(
  samples: ReadonlyArray<SuitabilitySample>,
  spacing: number,
  options: SuitabilityOptions = {},
  people?: ReadonlyArray<PeopleAt>,
  pops?: PopSeries,
): SuitabilityReport {
  const o = { ...DEFAULTS, ...options }
  const near = people && peopleIndex(people, undefined, o.minPersonScore)
  const frames = samples.map((s) => (near ? assessPeople(s, near(s.t), o) : assessFrame(s.t, s.mask, o)))
  const popping: number[] = []
  pops?.shares.forEach((p, i) => {
    if (p >= POP_MIN_SHARE) popping.push(i)
  })
  return judge(
    {
      frames: frames.map((f) => ({
        t: f.t,
        verdict: f.verdict,
        coverage: Math.round(f.coverage * 1e4) / 1e4,
      })),
      spacing,
      pops: pops?.shares.length
        ? { start: pops.start, fps: pops.fps, count: pops.shares.length, popping }
        : null,
      ...(o.minRangeSeconds !== DEFAULTS.minRangeSeconds ? { minRangeSeconds: o.minRangeSeconds } : {}),
    },
    o,
  )
}

/**
 * The verdict for the part of a shot from `range.start` to `range.end` (media seconds), judged from a report's
 * evidence the same way as the whole shot (with its `minRangeSeconds`), so a clip that shows only part of its footage
 * is judged on that part.
 */
export function suitabilityInRange(
  evidence: SuitabilityEvidence,
  range: TimeRange,
  options: SuitabilityOptions = {},
): SuitabilityReport {
  const eps = 1e-6
  let frames = evidence.frames.filter((f) => f.t >= range.start - eps && f.t <= range.end + eps)
  // A part shorter than the spacing of the judged frames takes the one nearest its middle.
  if (!frames.length && evidence.frames.length) {
    const mid = (range.start + range.end) / 2
    frames = [evidence.frames.reduce((a, b) => (Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a))]
  }
  let pops: SuitabilityEvidence['pops'] = null
  const p = evidence.pops
  if (p) {
    const first = Math.max(0, Math.ceil((range.start - p.start) * p.fps - eps))
    const end = Math.min(p.count, Math.ceil((range.end - p.start) * p.fps - eps))
    if (end > first)
      pops = {
        start: p.start + first / p.fps,
        fps: p.fps,
        count: end - first,
        popping: p.popping.filter((i) => i >= first && i < end).map((i) => i - first),
      }
  }
  const kept = evidence.minRangeSeconds === undefined ? {} : { minRangeSeconds: evidence.minRangeSeconds }
  const o = { ...DEFAULTS, ...kept, ...options }
  return judge(
    { frames, spacing: evidence.spacing, pops, ...kept },
    { ...o, minRangeSeconds: Math.min(o.minRangeSeconds, range.end - range.start) },
  )
}

function judge(evidence: SuitabilityEvidence, o: Required<SuitabilityOptions>): SuitabilityReport {
  const { frames, spacing, pops } = evidence
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
      evidence,
    }
  }
  const usable = frames.filter((f) => f.verdict === 'ok').length
  const usableFraction = usable / n
  const meanCoverage = frames.reduce((a, f) => a + f.coverage, 0) / n

  const stability = pops?.count ? 1 - pops.popping.length / pops.count : null

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
    evidence,
  }
}

function usableRanges(
  frames: ReadonlyArray<{ t: number; verdict: SuitabilityFrameVerdict }>,
  spacing: number,
  minSeconds: number,
): TimeRange[] {
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
