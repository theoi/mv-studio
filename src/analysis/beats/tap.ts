/** Longest pause between taps of one run; a longer pause starts counting again. */
export const TAP_RESET_SECONDS = 2
/** Taps needed before a tempo is given (three intervals). */
export const MIN_TAPS = 4

/**
 * Tempo (BPM, one decimal) of the latest run of taps (seconds, ascending), or null with fewer than MIN_TAPS taps
 * in it. A line fitted through the taps averages out timing jitter; when a tap was missed or doubled, the median
 * interval is used instead.
 */
export function tapTempo(taps: readonly number[]): number | null {
  let first = taps.length - 1
  while (first > 0 && (taps[first] as number) - (taps[first - 1] as number) <= TAP_RESET_SECONDS) first--
  const run = taps.slice(first)
  if (run.length < MIN_TAPS) return null
  const gaps = run.slice(1).map((t, i) => t - (run[i] as number))
  const sorted = [...gaps].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median =
    sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
  const even = gaps.every((g) => Math.abs(g / median - 1) < 0.3)
  return Math.round(600 / (even ? slope(run) : median)) / 10
}

/** Least-squares slope of taps against their index: the beat period. */
function slope(taps: readonly number[]): number {
  const n = taps.length
  const meanI = (n - 1) / 2
  const meanT = taps.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  taps.forEach((t, i) => {
    num += (i - meanI) * (t - meanT)
    den += (i - meanI) ** 2
  })
  return num / den
}
