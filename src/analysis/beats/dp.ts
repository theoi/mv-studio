import { convolveSame, std } from '../dsp/stats.ts'

export interface DpOptions {
  /** Penalty weight on deviations from the expected period (higher = steadier). */
  tightness?: number
  /** Drop weak beats at the start and end. */
  trim?: boolean
}

/** Onset envelope smoothed with a Gaussian of width period/32 (Ellis 2007 local score). */
export function localScore(onset: ArrayLike<number>, period: number): Float64Array {
  const sd = std(onset) || 1
  const p = Math.max(1, Math.round(period))
  const kernel = new Float64Array(2 * p + 1)
  for (let j = 0; j <= 2 * p; j++) kernel[j] = Math.exp(-0.5 * (((j - p) * 32) / period) ** 2)
  const norm = Float64Array.from(onset, (v) => v / sd)
  return convolveSame(norm, kernel)
}

/**
 * Dynamic-programming beat tracker (Ellis 2007, as in librosa) on a salience curve.
 * `period` is the expected beat period in frames, either global or per frame (for tempo changes).
 * Returns beat positions in (fractional) frames.
 */
export function dpBeatTrack(
  salience: ArrayLike<number>,
  period: number | Float64Array,
  options: DpOptions = {},
): number[] {
  const tightness = options.tightness ?? 100
  const n = salience.length
  if (n === 0) return []
  let globalPeriod: number
  if (typeof period === 'number') globalPeriod = period
  else {
    const s = Float64Array.from(period).sort()
    globalPeriod = s[s.length >> 1]
  }
  const periodAt =
    typeof period === 'number' ? () => period : (i: number) => period[Math.min(period.length - 1, i)]
  const local = localScore(salience, globalPeriod)
  const cum = new Float64Array(n)
  const back = new Int32Array(n)
  let maxLocal = -Infinity
  for (let i = 0; i < n; i++) maxLocal = Math.max(maxLocal, local[i])
  const thresh = 0.01 * maxLocal
  let firstBeat = true
  let cachedP = NaN
  let txwt = new Float64Array(0)
  let minD = 1
  let maxD = 1
  for (let i = 0; i < n; i++) {
    const p = periodAt(i)
    if (p !== cachedP) {
      cachedP = p
      minD = Math.max(1, Math.round(p / 2))
      maxD = Math.max(minD, Math.round(2 * p))
      txwt = new Float64Array(maxD + 1)
      for (let d = minD; d <= maxD; d++) txwt[d] = -tightness * Math.log(d / p) ** 2
    }
    let best = -Infinity
    let arg = -1
    for (let d = minD; d <= maxD; d++) {
      const q = i - d
      const v = txwt[d] + (q >= 0 ? cum[q] : 0)
      if (v > best) {
        best = v
        arg = q
      }
    }
    cum[i] = local[i] + best
    if (firstBeat && local[i] < thresh) back[i] = -1
    else {
      back[i] = arg
      firstBeat = false
    }
  }
  const maxima: number[] = []
  for (let i = 0; i < n; i++) {
    const l = i > 0 ? cum[i - 1] : -Infinity
    const r = i < n - 1 ? cum[i + 1] : -Infinity
    if (cum[i] > l && cum[i] >= r) maxima.push(i)
  }
  if (maxima.length === 0) return []
  const sorted = maxima.map((i) => cum[i]).sort((a, b) => a - b)
  const med = sorted[sorted.length >> 1]
  let tail = maxima[maxima.length - 1]
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (2 * cum[maxima[k]] > med) {
      tail = maxima[k]
      break
    }
  }
  const frames: number[] = []
  for (let b = tail; b >= 0; b = back[b]) frames.push(b)
  frames.reverse()
  let beats = frames
  if (options.trim ?? true) {
    const vals = beats.map((b) => local[b])
    const smooth = convolveSame(vals, [0.5, 1, 0.5])
    let ms = 0
    for (const v of smooth) ms += v * v
    const threshold = 0.5 * Math.sqrt(ms / Math.max(1, smooth.length))
    let a = 0
    let z = smooth.length - 1
    while (a <= z && smooth[a] <= threshold) a++
    while (z >= a && smooth[z] <= threshold) z--
    beats = beats.slice(a, z + 1)
  }
  return beats.map((b) => refinePeak(salience, b))
}

/** Parabolic sub-frame refinement around a local maximum of `curve`. */
export function refinePeak(curve: ArrayLike<number>, b: number): number {
  if (b <= 0 || b >= curve.length - 1) return b
  let i = b
  if (curve[i - 1] > curve[i] && curve[i - 1] >= curve[i + 1]) i--
  else if (curve[i + 1] > curve[i]) i++
  if (i <= 0 || i >= curve.length - 1 || Math.abs(i - b) > 1) return b
  const y0 = curve[i - 1]
  const y1 = curve[i]
  const y2 = curve[i + 1]
  const den = y0 - 2 * y1 + y2
  if (den >= 0) return i
  return i + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den))
}
