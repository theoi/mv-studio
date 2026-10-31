import { RealFFT } from '../dsp/fft.ts'

export interface TempoCandidate {
  bpm: number
  score: number
}

export interface TempoEstimate {
  bpm: number
  /** Beat period in frames (fractional). */
  period: number
  /** Prior-weighted local maxima, best first. */
  candidates: TempoCandidate[]
  /** Normalized autocorrelation (lag in frames -> value), averaged over the song. */
  acf: Float64Array
}

export interface TempoOptions {
  minBpm?: number
  maxBpm?: number
  /** Center of the log-normal tempo prior. */
  priorBpm?: number
  /** Width of the prior in octaves. */
  priorOctaves?: number
  /** Autocorrelation window in seconds. */
  windowSeconds?: number
  /** Weight of the autocorrelation at twice the period. */
  doubleWeight?: number
}

/** Windowed autocorrelation of the onset envelope, each window normalized to lag 0, averaged. */
export function onsetAutocorrelation(
  onset: ArrayLike<number>,
  fps: number,
  maxLag: number,
  windowSeconds = 8,
): Float64Array {
  const n = onset.length
  const win = Math.min(n, Math.round(windowSeconds * fps))
  const hop = Math.max(1, Math.round(fps))
  let size = 1
  while (size < 2 * win) size <<= 1
  const fft = new RealFFT(Math.max(4, size))
  const buf = new Float64Array(fft.n)
  const re = new Float64Array(fft.bins)
  const im = new Float64Array(fft.bins)
  const r = new Float64Array(fft.n)
  const acc = new Float64Array(maxLag + 1)
  const hann = new Float64Array(win)
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, win - 1))
  let count = 0
  for (let start = 0; start + win <= n; start += hop) {
    let m = 0
    for (let i = 0; i < win; i++) m += onset[start + i]
    m /= win
    buf.fill(0)
    for (let i = 0; i < win; i++) buf[i] = (onset[start + i] - m) * hann[i]
    fft.forward(buf, re, im)
    for (let k = 0; k < fft.bins; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k]
      im[k] = 0
    }
    fft.inverse(re, im, r)
    if (r[0] <= 1e-12) continue
    for (let l = 0; l <= maxLag && l < fft.n; l++) acc[l] += r[l] / r[0]
    count++
  }
  if (count > 0) for (let l = 0; l <= maxLag; l++) acc[l] /= count
  return acc
}

function interp(a: Float64Array, x: number): number {
  const i = Math.floor(x)
  if (i < 0) return a[0]
  if (i >= a.length - 1) return a[a.length - 1]
  return a[i] + (a[i + 1] - a[i]) * (x - i)
}

export function estimateTempo(
  onset: ArrayLike<number>,
  fps: number,
  options: TempoOptions = {},
): TempoEstimate {
  const minBpm = options.minBpm ?? 50
  const maxBpm = options.maxBpm ?? 220
  const prior = options.priorBpm ?? 120
  const sigma = options.priorOctaves ?? 1
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm))
  const maxLag = Math.ceil((60 * fps) / minBpm)
  const acf = onsetAutocorrelation(onset, fps, 2 * maxLag + 2, options.windowSeconds)
  const score = new Float64Array(maxLag + 2)
  for (let l = minLag; l <= maxLag + 1; l++) {
    const bpm = (60 * fps) / l
    const w = Math.exp(-0.5 * (Math.log2(bpm / prior) / sigma) ** 2)
    // Reward periods whose double also repeats; this damps eighth-note (double-time) peaks.
    const s = Math.max(0, acf[l]) + (options.doubleWeight ?? 0.5) * Math.max(0, interp(acf, 2 * l))
    score[l] = s * w
  }
  const candidates: TempoCandidate[] = []
  let bestLag = minLag
  for (let l = minLag; l <= maxLag; l++) {
    if (score[l] > score[bestLag]) bestLag = l
    if (l > minLag && score[l] >= score[l - 1] && score[l] >= score[l + 1] && score[l] > 0) {
      candidates.push({ bpm: (60 * fps) / l, score: score[l] })
    }
  }
  let period = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const a = score[bestLag - 1]
    const b = score[bestLag]
    const c = score[bestLag + 1]
    const den = a - 2 * b + c
    if (den < 0) period += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
  }
  candidates.sort((x, y) => y.score - x.score)
  const top = candidates[0]?.score || 1
  return {
    bpm: (60 * fps) / period,
    period,
    candidates: candidates
      .slice(0, 6)
      .map((c) => ({ bpm: +c.bpm.toFixed(2), score: +(c.score / top).toFixed(3) })),
    acf,
  }
}
