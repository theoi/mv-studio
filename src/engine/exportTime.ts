/**
 * The time left in an export while it renders. Early on, the frames done are too few, and often too cheap (a quiet
 * intro), to extrapolate from: a straight line over the first 3% of a project said 4 min where 14 were left. So the
 * export starts from what a trial before it expected (src/export/estimate.ts), and over its first frames moves to
 * its own measured pace, compared with what the trial expected for the same frames.
 *
 * That pace is measured over the latest tenth of the frames, not all of them: the trial samples only some frames, so
 * where its profile of the costs is off (an opening cheaper than expected) or the device slows down as it runs, the
 * pace of the frames so far kept saying a third too little from halfway on.
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

/**
 * Seconds left in an export of `frameCount` frames, from frames done and seconds since the first frame started.
 * With nothing expected, no figure shows until a tenth of the frames are done. Keep one per export: it remembers
 * what it last said and the updates its pace is measured over.
 */
export function exportTimeLeft(
  frameCount: number,
  expected?: ExpectedTime,
): (framesDone: number, elapsedSeconds: number) => number | undefined {
  let shown: number | undefined
  /** The share of the frames done and the seconds elapsed where the pace is measured from. */
  let from = { share: 0, seconds: 0 }
  /** The same at each update after `from`. */
  const later: (typeof from)[] = []
  return (framesDone, elapsedSeconds) => {
    const f = Math.min(1, framesDone / Math.max(1, frameCount))
    if (!(f > 0)) return undefined
    while ((later[0]?.share ?? Infinity) <= f - PACE_SHARE) from = later.shift() ?? from
    later.push({ share: f, seconds: elapsedSeconds })
    let left: number
    if (expected && expected.seconds > 0) {
      const done = expectedShare(expected, f)
      const since = done - expectedShare(expected, from.share)
      // How much slower (above 1) or faster this export runs than expected, over the same recent frames.
      const pace = since > 0 ? (elapsedSeconds - from.seconds) / (expected.seconds * since) : 1
      const trust = Math.min(1, f / TRUST_SHARE)
      left = (1 - trust + trust * pace) * expected.seconds * (1 - done)
    } else {
      if (f < TRUST_SHARE) return undefined
      left = ((elapsedSeconds - from.seconds) * (1 - f)) / (f - from.share)
    }
    if (shown !== undefined && left > shown) left = shown + (left - shown) * RISE
    shown = left
    return Math.max(0, Math.round(left))
  }
}
