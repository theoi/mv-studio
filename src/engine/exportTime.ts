/**
 * The time left in an export while it renders. Early on, the frames done are too few, and often too cheap (a quiet
 * intro), to extrapolate from: a straight line over the first 3% of a project said 4 min where 14 were left. So the
 * export starts from what a trial before it expected (src/export/estimate.ts), and over its first frames moves to
 * its own measured pace, compared with what the trial expected for the same frames.
 *
 * That pace is the export's own over the latest tenth of the frames. The trial samples only some frames, so it can
 * misjudge a part of the project (an opening cheaper than expected), and a device can slow down as it runs; frames
 * further back would keep the figure off for the rest of the export. Within that tenth it is the mean pace between
 * updates, weighted by the work each covered, with each update capped at a few times the median: a one-off stall
 * then counts for little, while stretches at different paces (looks the trial misjudged against each other) still
 * average out instead of the figure jumping between them.
 */

/** What a trial before an export expects its frames to take. */
export interface ExpectedTime {
  /** Seconds to render and encode every frame, without the work before and after the frames. */
  seconds: number
  /**
   * The share of `seconds` expected done after each hundredth of the frames: 101 values from 0 to 1. Missing means
   * every frame costs the same.
   */
  profile?: readonly number[]
}

/** The share of the frames after which the export's own pace has fully replaced the expected one. */
const TRUST_SHARE = 0.1

/** The share of the frames, the latest ones, that the export's pace is measured over. */
const PACE_SHARE = 0.1

/** How much of a rise in the time left shows at each update, so the figure eases up instead of jumping. */
const RISE = 0.2

/** The most an update counts at, as a multiple of the median pace between updates: more is a one-off stall. */
const STALL_CAP = 3

/** The share of the expected time done once `share` of the frames are done. */
export function expectedShare(expected: ExpectedTime, share: number): number {
  const profile = expected.profile
  const f = Math.min(1, Math.max(0, share))
  if (!profile || profile.length < 2) return f
  const x = f * (profile.length - 1)
  const i = Math.min(profile.length - 2, Math.floor(x))
  const a = profile[i] ?? 0
  const b = profile[i + 1] ?? 1
  return a + (b - a) * (x - i)
}

/** Where an export stood at an update: the shares of its frames and of its expected work done, and seconds elapsed. */
interface Point {
  share: number
  work: number
  seconds: number
}

/**
 * Seconds per unit of work between successive points, averaged by work, each first capped at `STALL_CAP` times their
 * weighted median.
 */
function paceRate(points: readonly Point[]): number | undefined {
  const steps: { rate: number; work: number }[] = []
  let prev: Point | undefined
  for (const p of points) {
    if (prev && p.work > prev.work)
      steps.push({ rate: (p.seconds - prev.seconds) / (p.work - prev.work), work: p.work - prev.work })
    prev = p
  }
  const total = steps.reduce((sum, s) => sum + s.work, 0)
  if (!(total > 0)) return undefined
  let half = total / 2
  let median = 0
  for (const s of [...steps].sort((a, b) => a.rate - b.rate)) {
    half -= s.work
    if (half <= 0) {
      median = s.rate
      break
    }
  }
  const cap = median > 0 ? STALL_CAP * median : Infinity
  return steps.reduce((sum, s) => sum + Math.min(s.rate, cap) * s.work, 0) / total
}

/**
 * Seconds left in an export of `frameCount` frames, from frames done and seconds since the first frame started.
 * With nothing expected, no figure shows until a tenth of the frames are done. Keep one per export: it remembers
 * what it last said and the updates its pace is measured over.
 */
export function exportTimeLeft(
  frameCount: number,
  expected?: ExpectedTime,
): (framesDone: number, elapsedSeconds: number) => number | undefined {
  const expects = expected !== undefined && expected.seconds > 0
  const workAt = (share: number) => (expected && expects ? expectedShare(expected, share) : share)
  let shown: number | undefined
  /** The update the pace is measured from: the latest at or before the start of the latest tenth of the frames. */
  let from: Point = { share: 0, work: 0, seconds: 0 }
  /** Each update after `from`. */
  const later: Point[] = []
  return (framesDone, elapsedSeconds) => {
    const f = Math.min(1, framesDone / Math.max(1, frameCount))
    if (!(f > 0)) return undefined
    while ((later[0]?.share ?? Infinity) <= f - PACE_SHARE) from = later.shift() ?? from
    later.push({ share: f, work: workAt(f), seconds: elapsedSeconds })
    const rate = paceRate([from, ...later])
    let left: number
    if (expected && expects) {
      const done = expectedShare(expected, f)
      // How much slower (above 1) or faster this export runs than expected, over the same recent frames.
      const pace = rate === undefined ? 1 : rate / expected.seconds
      const trust = Math.min(1, f / TRUST_SHARE)
      left = (1 - trust + trust * pace) * expected.seconds * (1 - done)
    } else {
      if (f < TRUST_SHARE) return undefined
      left = (rate ?? (elapsedSeconds - from.seconds) / (f - from.share)) * (1 - f)
    }
    if (shown !== undefined && left > shown) left = shown + (left - shown) * RISE
    shown = left
    return Math.max(0, Math.round(left))
  }
}
