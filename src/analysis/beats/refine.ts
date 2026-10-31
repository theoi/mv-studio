import { type BeatThisLogits, beatThisPeaks, sigmoid } from './beatThis.ts'
import { dpBeatTrack } from './dp.ts'
import { type BeatGrid, inferBarPositions, makeGrid } from './grid.ts'
import type { TempoCandidate } from './tempo.ts'

export interface RefineOptions {
  /** Tempo of the fast DSP grid, used to pick the beat level when Beat This! is inconsistent. */
  dspBpm?: number
  tempoCandidates?: TempoCandidate[]
  tightness?: number
  /** Fraction of Beat This! intervals that must agree for its own level to be trusted. */
  consistency?: number
}

function octaveFold(ibi: number, period: number): number | null {
  for (const f of [1, 2, 0.5, 3, 1 / 3]) {
    const v = ibi / f
    if (Math.abs(v - period) <= 0.12 * period) return v
  }
  return null
}

/**
 * Turns Beat This! logits into one consistent beat grid: the beat level is fixed for the whole
 * song (no half/double-time flips), beats follow local tempo, downbeats come from a bar HMM.
 */
export function refineWithBeatThis(logits: BeatThisLogits, options: RefineOptions = {}): BeatGrid {
  const fps = logits.fps
  const beatAct = Float64Array.from(logits.beat, sigmoid)
  const downAct = Float64Array.from(logits.downbeat, sigmoid)
  const peaks = beatThisPeaks(logits.beat, fps)
  const ibis = peaks.slice(1).map((t, i) => t - peaks[i])
  if (ibis.length < 4) {
    return makeGrid(
      'beat-this',
      peaks,
      inferBarPositions(peaks.map(() => 0.25)),
      options.tempoCandidates ?? [],
      false,
    )
  }
  const sorted = [...ibis].sort((a, b) => a - b)
  const medIbi = sorted[sorted.length >> 1]
  const agree = ibis.filter((x) => Math.abs(x - medIbi) <= 0.1 * medIbi).length / ibis.length
  let levelPeriod = medIbi
  if (agree < (options.consistency ?? 0.8) && options.dspBpm && options.dspBpm > 0) {
    // Beat This! switches levels within the song; follow the DSP level, folded onto its beats.
    const dspPeriod = 60 / options.dspBpm
    const folded = ibis.map((x) => octaveFold(x, dspPeriod)).filter((x): x is number => x !== null)
    if (folded.length >= ibis.length * 0.5) {
      const s = folded.sort((a, b) => a - b)
      levelPeriod = s[s.length >> 1]
    } else levelPeriod = dspPeriod
  }
  // Local period curve (frames) from octave-folded intervals, median over +-8 beats.
  const n = beatAct.length
  const local = new Float64Array(n).fill(levelPeriod * fps)
  const pts: { t: number; p: number }[] = []
  for (let i = 0; i < ibis.length; i++) {
    const f = octaveFold(ibis[i], levelPeriod)
    if (f !== null) pts.push({ t: (peaks[i] + peaks[i + 1]) / 2, p: f })
  }
  if (pts.length >= 4) {
    const smooth = pts.map((_, i) => {
      const w = pts
        .slice(Math.max(0, i - 8), i + 9)
        .map((x) => x.p)
        .sort((a, b) => a - b)
      return w[w.length >> 1]
    })
    let j = 0
    for (let f = 0; f < n; f++) {
      const t = f / fps
      while (j < pts.length - 1 && pts[j + 1].t <= t) j++
      local[f] = smooth[j] * fps
    }
  }
  const beatFrames = dpBeatTrack(beatAct, local, { tightness: options.tightness ?? 400 })
  const beats = beatFrames.map((f) => f / fps)
  const likelihood = beatFrames.map((f) => {
    const c = Math.round(f)
    let m = 0
    for (let k = Math.max(0, c - 2); k <= Math.min(n - 1, c + 2); k++) m = Math.max(m, downAct[k])
    return m
  })
  const bar = inferBarPositions(likelihood)
  return makeGrid('beat-this', beats, bar, options.tempoCandidates ?? [], true)
}
