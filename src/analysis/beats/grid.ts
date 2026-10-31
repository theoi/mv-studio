import type { TempoCandidate } from './tempo.ts'

/** Serializable beat grid stored with the project. Times are in seconds from the song start. */
export interface BeatGrid {
  version: 1
  /** 'dsp' is the fast estimate; 'beat-this' is the refined result. */
  source: 'dsp' | 'beat-this'
  bpm: number
  beats: number[]
  /** Position of each beat in its bar, 1-based (1 = downbeat). Same length as `beats`. */
  barPositions: number[]
  beatsPerBar: number
  downbeats: number[]
  /** False while downbeats are only a heuristic guess (fast path). */
  downbeatsReliable: boolean
  tempoCandidates: TempoCandidate[]
  /** True when beat intervals stay within a few percent of the global tempo. */
  steady: boolean
}

export function bpmFromBeats(beats: readonly number[]): number {
  if (beats.length < 2) return 0
  const n = beats.length
  const mx = (n - 1) / 2
  let my = 0
  for (const b of beats) my += b
  my /= n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (beats[i] - my)
    sxx += (i - mx) ** 2
  }
  const slope = sxy / sxx
  return slope > 0 ? 60 / slope : 0
}

/** True if a constant-tempo line explains the beats with small drift. */
export function isSteady(beats: readonly number[]): boolean {
  if (beats.length < 8) return false
  const ibis = beats.slice(1).map((t, i) => t - beats[i])
  const sorted = [...ibis].sort((a, b) => a - b)
  const med = sorted[sorted.length >> 1]
  const within = ibis.filter((x) => Math.abs(x - med) <= 0.05 * med).length / ibis.length
  return within >= 0.9
}

export interface BarModelOptions {
  meters?: number[]
  /** Probability of breaking the bar cycle at any beat (pickups, odd bars). */
  breakProbability?: number
  /** Log-likelihood bonus per beat required to prefer a meter other than 4. */
  nonFourPenalty?: number
}

/**
 * Assigns bar positions with a cyclic HMM over beats. `downbeatLikelihood[i]` in (0,1) is the
 * evidence that beat i starts a bar.
 */
export function inferBarPositions(
  downbeatLikelihood: readonly number[],
  options: BarModelOptions = {},
): { beatsPerBar: number; positions: number[]; score: number } {
  const meters = options.meters ?? [3, 4]
  const eps = options.breakProbability ?? 0.02
  const penalty = options.nonFourPenalty ?? 0.05
  const n = downbeatLikelihood.length
  let best = { beatsPerBar: 4, positions: Array.from({ length: n }, (_, i) => (i % 4) + 1), score: -Infinity }
  if (n === 0) return { ...best, positions: [] }
  for (const m of meters) {
    const logStay = Math.log(1 - eps)
    const logJump = Math.log(eps / Math.max(1, m - 1))
    const emit = (i: number, k: number) => {
      const p = Math.min(0.99, Math.max(0.01, downbeatLikelihood[i]))
      return k === 0 ? Math.log(p) : Math.log(1 - p)
    }
    let prev = new Float64Array(m)
    for (let k = 0; k < m; k++) prev[k] = emit(0, k) - Math.log(m)
    const back = new Uint8Array(n * m)
    for (let i = 1; i < n; i++) {
      const cur = new Float64Array(m)
      for (let k = 0; k < m; k++) {
        let bv = -Infinity
        let bj = 0
        for (let j = 0; j < m; j++) {
          const v = prev[j] + ((j + 1) % m === k ? logStay : logJump)
          if (v > bv) {
            bv = v
            bj = j
          }
        }
        cur[k] = bv + emit(i, k)
        back[i * m + k] = bj
      }
      prev = cur
    }
    let k = 0
    for (let j = 1; j < m; j++) if (prev[j] > prev[k]) k = j
    const score = prev[k] / n - (m === 4 ? 0 : penalty)
    const positions = new Array<number>(n)
    for (let i = n - 1; i >= 0; i--) {
      positions[i] = k + 1
      k = back[i * m + k]
    }
    if (score > best.score) best = { beatsPerBar: m, positions, score }
  }
  return best
}

export function makeGrid(
  source: BeatGrid['source'],
  beats: number[],
  bar: { beatsPerBar: number; positions: number[] },
  tempoCandidates: TempoCandidate[],
  downbeatsReliable: boolean,
): BeatGrid {
  const rounded = beats.map((b) => Math.round(b * 1e4) / 1e4)
  return {
    version: 1,
    source,
    bpm: Math.round(bpmFromBeats(rounded) * 100) / 100,
    beats: rounded,
    barPositions: bar.positions,
    beatsPerBar: bar.beatsPerBar,
    downbeats: rounded.filter((_, i) => bar.positions[i] === 1),
    downbeatsReliable,
    tempoCandidates,
    steady: isSteady(rounded),
  }
}

function lowerBound(a: readonly number[], t: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the beat nearest to time t (or -1 for an empty grid). */
export function nearestBeatIndex(grid: Pick<BeatGrid, 'beats'>, t: number): number {
  const b = grid.beats
  if (b.length === 0) return -1
  const i = lowerBound(b, t)
  if (i === 0) return 0
  if (i === b.length) return b.length - 1
  return t - b[i - 1] <= b[i] - t ? i - 1 : i
}

/**
 * Snap points at `division` subdivisions per beat (1 = beats, 2 = eighths, 4 = sixteenths);
 * `division` < 1 snaps to bars when 1 / division equals beatsPerBar.
 */
export function gridPoints(grid: Pick<BeatGrid, 'beats' | 'barPositions'>, division: number): number[] {
  const b = grid.beats
  if (division <= 0) throw new RangeError('division must be positive')
  if (division < 1) return b.filter((_, i) => grid.barPositions[i] === 1)
  const out: number[] = []
  for (let i = 0; i < b.length; i++) {
    out.push(b[i])
    if (i + 1 < b.length)
      for (let k = 1; k < division; k++) out.push(b[i] + ((b[i + 1] - b[i]) * k) / division)
  }
  return out
}

/** Nearest snap point to t at the given subdivision. */
export function snapToGrid(grid: Pick<BeatGrid, 'beats' | 'barPositions'>, t: number, division = 1): number {
  const pts = gridPoints(grid, division)
  if (pts.length === 0) return t
  const i = lowerBound(pts, t)
  if (i === 0) return pts[0]
  if (i === pts.length) return pts[pts.length - 1]
  return t - pts[i - 1] <= pts[i] - t ? pts[i - 1] : pts[i]
}

/** User override: double (factor 2) or halve (factor 0.5) the beat level, keeping downbeats. */
export function rescaleGrid(grid: BeatGrid, factor: 2 | 0.5): BeatGrid {
  const b = grid.beats
  let beats: number[]
  let positions: number[]
  if (factor === 2) {
    beats = []
    positions = []
    for (let i = 0; i < b.length; i++) {
      beats.push(b[i])
      positions.push(2 * grid.barPositions[i] - 1)
      if (i + 1 < b.length) {
        beats.push((b[i] + b[i + 1]) / 2)
        positions.push(2 * grid.barPositions[i])
      }
    }
    return makeGrid(
      grid.source,
      beats,
      { beatsPerBar: grid.beatsPerBar * 2, positions },
      grid.tempoCandidates,
      grid.downbeatsReliable,
    )
  }
  const keep = grid.barPositions.map((p) => p % 2 === 1)
  if (grid.beatsPerBar % 2 !== 0) keep.fill(false).forEach((_, i) => (keep[i] = i % 2 === 0))
  beats = b.filter((_, i) => keep[i])
  positions = grid.barPositions.filter((_, i) => keep[i]).map((p) => Math.ceil(p / 2))
  const bpb = Math.max(1, Math.ceil(grid.beatsPerBar / 2))
  return makeGrid(
    grid.source,
    beats,
    { beatsPerBar: bpb, positions },
    grid.tempoCandidates,
    grid.downbeatsReliable,
  )
}

/** How much of the beat interval a downbeat may be away from a beat and still fall on it. */
const FIT_TOLERANCE = 0.25
/** Share of the downbeats inside the beats' span that must fall on a beat for the bars to fit. */
const FIT_SHARE = 0.8

/**
 * Bars found on one grid (`downbeats`, e.g. Beat This!'s) put on the beats of another (the user's tempo, a grid
 * tracked again): each downbeat moves to the beat it falls on, within a quarter of the beat interval and 70 ms.
 * Null when fewer than 80% of them fall on a beat (a different beat level or phase), or fewer than two do.
 */
export function fitDownbeats(beats: readonly number[], downbeats: readonly number[]): number[] | null {
  if (beats.length < 2) return null
  const first = beats[0] as number
  const last = beats[beats.length - 1] as number
  const inside = downbeats.filter((d) => d >= first - 0.07 && d <= last + 0.07)
  const fitted = new Set<number>()
  for (const d of inside) {
    const i = nearestBeatIndex({ beats: beats as number[] }, d)
    const b = beats[i] as number
    const neighbour = beats[i + 1 < beats.length ? i + 1 : i - 1] as number
    if (Math.abs(b - d) <= Math.min(0.07, FIT_TOLERANCE * Math.abs(neighbour - b))) fitted.add(b)
  }
  if (fitted.size < 2 || fitted.size < FIT_SHARE * inside.length) return null
  return [...fitted].sort((a, b) => a - b)
}

/**
 * Bars put on beats of another level than the one they were found on (the user doubled, halved or tapped the tempo)
 * span 8 or 2 of those beats. Eight beats are two bars of four, so a bar also starts on the beat halfway, and four
 * beats before the first bar and after the last when the song has them, as the found bars ran on before and after
 * their first and last starts. Two beats are half a bar, and which beat of each pair starts a bar is unknown, so
 * there are no bars (null). Other lengths are kept.
 */
export function barsOfFour(beats: readonly number[], downbeats: readonly number[]): number[] | null {
  const index = new Map(beats.map((t, i) => [t, i] as const))
  const at = downbeats.map((d) => index.get(d)).filter((i): i is number => i !== undefined)
  const gaps = at
    .slice(1)
    .map((i, k) => i - (at[k] as number))
    .sort((a, b) => a - b)
  const median = gaps[gaps.length >> 1]
  if (median === 2) return null
  if (median !== 8) return [...downbeats]
  const first = at[0] as number
  const last = at[at.length - 1] as number
  const out: number[] = first >= 4 ? [beats[first - 4] as number] : []
  at.forEach((i, k) => {
    out.push(beats[i] as number)
    const next = at[k + 1]
    if (next !== undefined && next - i >= 6) out.push(beats[i + Math.round((next - i) / 2)] as number)
  })
  if (last + 4 < beats.length) out.push(beats[last + 4] as number)
  return out
}

/** User override: make beat `index` the first beat of a bar and renumber the rest. */
export function setDownbeat(grid: BeatGrid, index: number, beatsPerBar = grid.beatsPerBar): BeatGrid {
  if (index < 0 || index >= grid.beats.length) throw new RangeError('beat index out of range')
  const positions = grid.beats.map((_, i) => ((((i - index) % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1)
  return makeGrid(grid.source, grid.beats, { beatsPerBar, positions }, grid.tempoCandidates, true)
}
