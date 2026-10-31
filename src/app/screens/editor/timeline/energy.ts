import type { FeatureSeries } from '../../../../model/index.ts'

/** The energy curve is averaged over at least this long, so beat-to-beat swings don't draw as a zigzag. */
export const ENERGY_SMOOTH_SECONDS = 1.5

/**
 * The song's energy at time t, averaged over `window` seconds (at least `ENERGY_SMOOTH_SECONDS`) around it; 0 outside
 * the song. A running sum read at fractional positions makes the mean move smoothly with t at any zoom.
 */
export function energySampler(series: FeatureSeries | undefined): (t: number, window: number) => number {
  const values = series?.values ?? []
  const rate = series?.rate ?? 1
  const end = values.length / rate
  const sums = new Float64Array(values.length + 1)
  values.forEach((v, i) => (sums[i + 1] = (sums[i] as number) + v))
  const sumTo = (t: number) => {
    const x = Math.min(values.length, Math.max(0, t * rate))
    const i = Math.floor(x)
    return (sums[i] as number) + (i < values.length ? (x - i) * (values[i] as number) : 0)
  }
  return (t, window) => {
    const half = Math.max(ENERGY_SMOOTH_SECONDS, window) / 2
    const a = Math.max(0, t - half)
    const b = Math.min(end, t + half)
    return b > a ? (sumTo(b) - sumTo(a)) / ((b - a) * rate) : 0
  }
}
