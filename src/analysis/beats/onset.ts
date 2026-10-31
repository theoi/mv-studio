import type { SpectralAnalysis } from '../frontend.ts'

export interface OnsetOptions {
  /** Highest mel band (exclusive) to include; defaults to all bands. */
  bandLimit?: number
  /** Lowest mel band to include. */
  bandStart?: number
  /** Frequency max-filter half width (SuperFlux); 0 disables. */
  maxRadius?: number
  /** Dynamic range floor below the loudest bin, in dB. */
  topDb?: number
}

/**
 * Spectral-flux onset strength: mean positive change of log-mel energy between consecutive frames.
 * Value i describes the change arriving at frame i.
 */
export function onsetStrength(spec: SpectralAnalysis, options: OnsetOptions = {}): Float32Array {
  const { frames, nMels, melDb } = spec
  const start = options.bandStart ?? 0
  const end = Math.min(nMels, options.bandLimit ?? nMels)
  const radius = options.maxRadius ?? 0
  const topDb = options.topDb ?? 80
  let maxDb = -Infinity
  for (let i = 0; i < melDb.length; i++) if (melDb[i] > maxDb) maxDb = melDb[i]
  const floor = maxDb - topDb
  const v = (f: number, m: number) => Math.max(floor, melDb[f * nMels + m])
  const out = new Float32Array(frames)
  for (let f = 1; f < frames; f++) {
    let s = 0
    for (let m = start; m < end; m++) {
      let ref = v(f - 1, m)
      for (let r = 1; r <= radius; r++) {
        if (m - r >= 0) ref = Math.max(ref, v(f - 1, m - r))
        if (m + r < nMels) ref = Math.max(ref, v(f - 1, m + r))
      }
      const d = v(f, m) - ref
      if (d > 0) s += d
    }
    out[f] = s / (end - start)
  }
  return out
}
