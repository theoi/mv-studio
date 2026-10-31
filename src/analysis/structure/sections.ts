import type { SpectralAnalysis } from '../frontend.ts'
import type { BeatGrid } from '../beats/grid.ts'
import { quantile } from '../dsp/stats.ts'

export type SectionLabel = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro'

export interface Section {
  start: number
  end: number
  label: SectionLabel
  /** Repetition group: sections with the same letter sound alike. */
  group: string
  /** Mean normalized energy (0..1) of the section. */
  energy: number
}

export interface SongSections {
  version: 1
  sections: Section[]
  /**
   * Time ranges of the chorus: the most repeated loud passage when one stands out, else the sections labeled chorus.
   * The section labels do not follow it yet; `withChorus` (structure/chorus.ts) cuts and relabels them.
   */
  chorus: { start: number; end: number }[]
}

export interface EnergyCurve {
  version: 1
  /** Values per second (curve point i is at t = i / fps). */
  fps: number
  /** Normalized 0..1 intensity combining loudness and onset density. */
  values: number[]
}

export interface StructureOptions {
  /** Checkerboard half-width in beats for the homogeneity novelty. */
  kernelBeats?: number
  /** Boundary threshold in novelty standard deviations above the mean. */
  threshold?: number
  /** Similarity above which two segments join the same group. */
  groupThreshold?: number
  debug?: (info: {
    segments: { start: number; end: number; group: number }[]
    novelty: Float64Array
    barScore: Float64Array
  }) => void
}

interface BeatFeatures {
  times: number[]
  chroma: Float64Array[]
  timbre: Float64Array[]
  loud: Float64Array
}

function dctMfcc(mel: Float64Array, nCoef: number): Float64Array {
  const n = mel.length
  const out = new Float64Array(nCoef)
  for (let c = 1; c <= nCoef; c++) {
    let s = 0
    for (let j = 0; j < n; j++) s += mel[j] * Math.cos((Math.PI * c * (j + 0.5)) / n)
    out[c - 1] = s
  }
  return out
}

function unit(v: Float64Array): Float64Array {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s) || 1
  return v.map((x) => x / n)
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Beat times used for structure analysis; falls back to a 0.5 s pulse when beats are sparse. */
function pulse(spec: SpectralAnalysis, grid: Pick<BeatGrid, 'beats'>): number[] {
  const b = grid.beats.filter((t) => t >= 0 && t < spec.duration)
  if (b.length >= 16) {
    const out = [0, ...b.filter((t) => t > 0.05), spec.duration]
    return out
  }
  const out: number[] = []
  for (let t = 0; t < spec.duration; t += 0.5) out.push(t)
  out.push(spec.duration)
  return out
}

function beatFeatures(spec: SpectralAnalysis, times: number[]): BeatFeatures {
  const { fps, frames, nMels, melDb, chroma } = spec
  const nb = times.length - 1
  const chromaF: Float64Array[] = []
  const timbre: Float64Array[] = []
  const loud = new Float64Array(nb)
  for (let i = 0; i < nb; i++) {
    const a = Math.min(frames - 1, Math.round(times[i] * fps))
    const z = Math.min(frames, Math.max(a + 1, Math.round(times[i + 1] * fps)))
    const c = new Float64Array(12)
    const m = new Float64Array(nMels)
    let p = 0
    for (let f = a; f < z; f++) {
      for (let k = 0; k < 12; k++) c[k] += chroma[f * 12 + k]
      for (let k = 0; k < nMels; k++) {
        m[k] += melDb[f * nMels + k]
        p += 10 ** (melDb[f * nMels + k] / 10)
      }
    }
    const cnt = z - a
    let mx = 0
    for (let k = 0; k < 12; k++) mx = Math.max(mx, c[k])
    chromaF.push(unit(c.map((v) => Math.log1p((10 * v) / (mx || 1)))))
    for (let k = 0; k < nMels; k++) m[k] /= cnt
    timbre.push(dctMfcc(m, 12))
    loud[i] = 10 * Math.log10(p / cnt + 1e-10)
  }
  for (let d = 0; d < 12; d++) {
    let mu = 0
    for (const c of chromaF) mu += c[d]
    mu /= nb
    let sd = 0
    for (const c of chromaF) sd += (c[d] - mu) ** 2
    sd = Math.sqrt(sd / nb) || 1
    for (const c of chromaF) c[d] = (c[d] - mu) / sd
  }
  for (let i = 0; i < nb; i++) chromaF[i] = unit(chromaF[i])
  // z-score timbre dimensions across the song
  for (let d = 0; d < 12; d++) {
    let mu = 0
    for (const t of timbre) mu += t[d]
    mu /= nb
    let sd = 0
    for (const t of timbre) sd += (t[d] - mu) ** 2
    sd = Math.sqrt(sd / nb) || 1
    for (const t of timbre) t[d] = (t[d] - mu) / sd
  }
  return { times, chroma: chromaF, timbre, loud }
}

function stack(v: Float64Array[], width: number): Float64Array[] {
  return v.map((_, i) => {
    const out = new Float64Array(v[0].length * width)
    for (let k = 0; k < width; k++) out.set(v[Math.min(v.length - 1, i + k)], k * v[0].length)
    return unit(out)
  })
}

function normalizeCurve(x: Float64Array): Float64Array {
  let mx = 0
  for (const v of x) mx = Math.max(mx, v)
  return mx > 0 ? x.map((v) => Math.max(0, v) / mx) : x
}

function footeNovelty(sim: (i: number, j: number) => number, n: number, half: number): Float64Array {
  const out = new Float64Array(n)
  const g = (a: number) => Math.exp(-0.5 * ((a + 0.5) / (half / 2)) ** 2)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let a = -half; a < half; a++) {
      const ia = i + a
      if (ia < 0 || ia >= n) continue
      for (let b = -half; b < half; b++) {
        const ib = i + b
        if (ib < 0 || ib >= n) continue
        const sign = a < 0 === b < 0 ? 1 : -1
        s += sign * g(a) * g(b) * sim(ia, ib)
      }
    }
    out[i] = s
  }
  return normalizeCurve(out)
}

/** Repetition novelty from time-lag structure features (Serrà et al. 2014). */
function repetitionNovelty(stacked: Float64Array[]): Float64Array {
  const n = stacked.length
  const k = Math.max(3, Math.round(0.06 * n))
  const rec = new Uint8Array(n * n)
  for (let i = 0; i < n; i++) {
    const sims: { j: number; s: number }[] = []
    for (let j = 0; j < n; j++) if (Math.abs(i - j) > 4) sims.push({ j, s: dot(stacked[i], stacked[j]) })
    sims.sort((a, b) => b.s - a.s)
    for (const { j } of sims.slice(0, k)) rec[i * n + j] = 1
  }
  const lag = new Float64Array(n * n)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (rec[i * n + j] && rec[j * n + i]) lag[i * n + ((j - i + n) % n)] = 1
  // Smooth along time (sigma 2 beats) and lag (sigma 1).
  const sm = new Float64Array(n * n)
  const kt = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((d) => ({ d, w: Math.exp(-0.5 * (d / 2) ** 2) }))
  const kl = [-2, -1, 0, 1, 2].map((d) => ({ d, w: Math.exp(-0.5 * d * d) }))
  for (let i = 0; i < n; i++)
    for (let l = 0; l < n; l++) {
      let s = 0
      for (const { d, w } of kt) {
        const ii = i + d
        if (ii < 0 || ii >= n) continue
        for (const { d: e, w: v } of kl) s += w * v * lag[ii * n + ((l + e + n) % n)]
      }
      sm[i * n + l] = s
    }
  const out = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    let s = 0
    for (let l = 0; l < n; l++) s += (sm[i * n + l] - sm[(i - 1) * n + l]) ** 2
    out[i] = Math.sqrt(s)
  }
  return normalizeCurve(out)
}

function lengthPrior(bars: number): number {
  if (bars === 4 || bars === 8 || bars === 16) return 0
  if (bars === 2 || bars === 6 || bars === 12) return -0.15
  return -0.35
}

const MIN_SECTION_SECONDS = 3

/** A pickup beat or a final ring-out is not a section of its own: merge such slivers into a neighbour. */
function mergeShortSegments(segs: { a: number; z: number }[], times: number[]): { a: number; z: number }[] {
  const out: { a: number; z: number }[] = []
  for (const s of segs) {
    const last = out.at(-1)
    if (last && times[s.z] - times[s.a] < MIN_SECTION_SECONDS) last.z = s.z
    else out.push({ ...s })
  }
  const [first, second] = out
  if (first && second && times[first.z] - times[first.a] < MIN_SECTION_SECONDS) {
    second.a = first.a
    out.shift()
  }
  return out
}

function segmentBars(barStarts: number[], barScore: Float64Array, threshold: number): number[] {
  // barStarts are beat indices; returns chosen boundary bar indices (always includes 0 and last).
  const m = barStarts.length
  const best = new Float64Array(m).fill(-Infinity)
  const prev = new Int32Array(m).fill(-1)
  best[0] = 0
  for (let b = 1; b < m; b++) {
    for (let a = Math.max(0, b - 32); a <= b - 1; a++) {
      if (best[a] === -Infinity) continue
      const len = b - a
      const isEdge = a === 0 || b === m - 1
      if (len < 2 && !isEdge) continue
      const gain =
        (b === m - 1 ? 0 : barScore[b] - threshold) +
        (isEdge ? Math.max(lengthPrior(len), -0.15) : lengthPrior(len))
      const v = best[a] + gain
      if (v > best[b]) {
        best[b] = v
        prev[b] = a
      }
    }
  }
  const out: number[] = []
  for (let b = m - 1; b >= 0; b = prev[b]) {
    out.push(b)
    if (b === 0) break
  }
  return out.reverse()
}

/**
 * Similarity of two beat ranges: best diagonal alignment of chroma (tolerating small key changes)
 * blended with timbre similarity. Roughly -1..1; repeats of the same part score high.
 */
function segmentSimilarity(
  feat: BeatFeatures,
  sigma2: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): number {
  const la = a1 - a0
  const lb = b1 - b0
  const len = Math.min(la, lb)
  if (len < 2) return -1
  let best = -Infinity
  for (let off = 0; off <= Math.abs(la - lb); off += 2) {
    let t = 0
    for (let k = 0; k < len; k++) {
      const i = la >= lb ? a0 + off + k : a0 + k
      const j = la >= lb ? b0 + k : b0 + off + k
      let e = 0
      for (let p = 0; p < 12; p++) e += (feat.timbre[i][p] - feat.timbre[j][p]) ** 2
      t += 2 * Math.exp(-e / sigma2) - 1
    }
    for (const shift of [0, 1, 2, 10, 11]) {
      let c = 0
      for (let k = 0; k < len; k++) {
        const i = la >= lb ? a0 + off + k : a0 + k
        const j = la >= lb ? b0 + k : b0 + off + k
        const ci = feat.chroma[i]
        const cj = feat.chroma[j]
        for (let p = 0; p < 12; p++) c += ci[p] * cj[(p + shift) % 12]
      }
      const v = 0.6 * (c / len) + 0.4 * (t / len) - (shift === 0 ? 0 : 0.05)
      if (v > best) best = v
    }
  }
  return best
}

/** A repeat must stand out from the song's typical self-similarity by this many standard deviations. */
const CHORUS_MIN_Z = 1.5
/** Preference for loud passages: fitness times 1 + CHORUS_LOUDNESS x (passage energy - song energy). */
const CHORUS_LOUDNESS = 8
/** Candidate chorus lengths in beats: 4 and 8 bars of 4/4. */
const CHORUS_BEATS = [16, 32]

/**
 * The chorus as the song's most repeated loud passage (audio thumbnailing), independent of the section boundaries.
 * For each 4- or 8-bar window starting on a bar, the other bar-aligned windows whose beat-by-beat similarity stands
 * out from the song's typical similarity are its repeats; the window whose repeats stand out most, weighted by length
 * and loudness, wins. Returns its occurrences as beat ranges, or [] when nothing repeats.
 */
function repeatedPassage(
  feat: BeatFeatures,
  sigma2: number,
  bars: number[],
  beatEnergy: Float64Array,
): { a: number; z: number }[] {
  const n = feat.chroma.length
  const S = new Float32Array(n * n)
  let sum = 0
  let sum2 = 0
  let count = 0
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      let e = 0
      for (let k = 0; k < 12; k++) e += (feat.timbre[i][k] - feat.timbre[j][k]) ** 2
      const v = 0.7 * Math.exp(-e / sigma2) + 0.3 * Math.max(0, dot(feat.chroma[i], feat.chroma[j]))
      S[i * n + j] = v
      S[j * n + i] = v
      if (j - i > 8) {
        sum += v
        sum2 += v * v
        count++
      }
    }
  if (count === 0) return []
  const mu = sum / count
  const sd = Math.sqrt(Math.max(1e-12, sum2 / count - mu * mu))
  let songEnergy = 0
  for (const e of beatEnergy) songEnergy += e / n
  let best = { fitness: 0, starts: [] as number[], length: 0 }
  for (const length of CHORUS_BEATS) {
    for (const a of bars) {
      if (a + length > n) break
      const repeats: { b: number; z: number }[] = []
      for (const b of bars) {
        if (b + length > n || Math.abs(b - a) < length) continue
        let v = 0
        for (let k = 0; k < length; k++) v += S[(a + k) * n + b + k]
        const z = (v / length - mu) / sd
        if (z >= CHORUS_MIN_Z) repeats.push({ b, z })
      }
      repeats.sort((x, y) => y.z - x.z)
      const starts = [a]
      let fitness = 0
      for (const r of repeats) {
        if (starts.some((s) => Math.abs(s - r.b) < length)) continue
        starts.push(r.b)
        fitness += r.z - CHORUS_MIN_Z
      }
      if (starts.length < 2) continue
      let e = 0
      for (const s of starts) for (let k = 0; k < length; k++) e += beatEnergy[s + k]
      e /= starts.length * length
      fitness *= length * Math.max(0.05, 1 + CHORUS_LOUDNESS * (e - songEnergy))
      if (fitness > best.fitness) best = { fitness, starts: starts.sort((x, y) => x - y), length }
    }
  }
  return best.starts.map((a) => ({ a, z: Math.min(n, a + best.length) }))
}

export function computeEnergyCurve(spec: SpectralAnalysis, onset: Float32Array, fps = 10): EnergyCurve {
  const step = Math.round(spec.fps / fps)
  const nb = spec.bandPower.length / spec.frames
  const n = Math.floor(spec.frames / step)
  const loud = new Float64Array(n)
  const dens = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let p = 0
    let o = 0
    for (let f = i * step; f < (i + 1) * step; f++) {
      for (let b = 0; b < nb; b++) p += spec.bandPower[f * nb + b]
      o += onset[f]
    }
    loud[i] = 10 * Math.log10(p / step + 1e-12)
    dens[i] = o / step
  }
  const smooth = (x: Float64Array, r: number) =>
    x.map((_, i) => {
      let s = 0
      let c = 0
      for (let k = Math.max(0, i - r); k <= Math.min(x.length - 1, i + r); k++) {
        s += x[k]
        c++
      }
      return s / c
    })
  const ls = smooth(loud, Math.round(1.5 * fps))
  const ds = smooth(dens, Math.round(1.5 * fps))
  const hi = quantile(ls, 0.98)
  const lo = Math.max(hi - 30, quantile(ls, 0.05))
  const dHi = quantile(ds, 0.98) || 1
  const values = Array.from(ls, (v, i) => {
    const l = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)))
    const d = Math.min(1, Math.max(0, ds[i] / dHi))
    return Math.round((0.75 * l + 0.25 * d) * 1000) / 1000
  })
  return { version: 1, fps, values }
}

export function analyzeStructure(
  spec: SpectralAnalysis,
  grid: Pick<BeatGrid, 'beats' | 'barPositions'>,
  energy: EnergyCurve,
  options: StructureOptions = {},
): SongSections {
  const times = pulse(spec, grid)
  const feat = beatFeatures(spec, times)
  const n = feat.chroma.length
  if (n < 8) {
    return {
      version: 1,
      sections: [{ start: 0, end: spec.duration, label: 'verse', group: 'A', energy: 0.5 }],
      chorus: [],
    }
  }
  const stacked = stack(feat.chroma, 4)
  let d2: number[] = []
  for (let i = 0; i < n; i += 3)
    for (let j = i + 1; j < n; j += 3) {
      let s = 0
      for (let k = 0; k < 12; k++) s += (feat.timbre[i][k] - feat.timbre[j][k]) ** 2
      d2.push(s)
    }
  d2 = d2.sort((a, b) => a - b)
  const sigma2 = d2[d2.length >> 1] || 1
  const sim = (i: number, j: number) => {
    let s = 0
    for (let k = 0; k < 12; k++) s += (feat.timbre[i][k] - feat.timbre[j][k]) ** 2
    return 0.5 * Math.exp(-s / sigma2) + 0.5 * Math.max(0, dot(feat.chroma[i], feat.chroma[j]))
  }
  const half = options.kernelBeats ?? 16
  const foote = footeNovelty(sim, n, half)
  const rep = repetitionNovelty(stacked)
  const nov = foote.map((v, i) => 0.5 * v + 0.5 * rep[i])

  // Candidate boundaries at bar starts (beat index i of `times` corresponds to beat interval i).
  const beatIdxOfTime = (t: number) => {
    let lo = 0
    let hi = times.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] < t - 1e-6) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const down = grid.beats.filter((_, i) => grid.barPositions[i] === 1)
  const startSet = new Set<number>([0, n])
  if (down.length >= 8 && n >= 16) {
    for (const t of down) if (t > 2 && t < spec.duration - 2) startSet.add(Math.min(n, beatIdxOfTime(t)))
  } else {
    for (let i = 4; i < n; i += 4) startSet.add(i)
  }
  const barStarts = [...startSet].sort((a, b) => a - b)
  const barScore = new Float64Array(barStarts.length)
  for (let b = 0; b < barStarts.length; b++) {
    let m = 0
    for (let k = barStarts[b] - 1; k <= barStarts[b] + 1; k++) if (k >= 0 && k < n) m = Math.max(m, nov[k])
    barScore[b] = m
  }
  let mu = 0
  for (const v of barScore) mu += v
  mu /= barScore.length
  let sd = 0
  for (const v of barScore) sd += (v - mu) ** 2
  sd = Math.sqrt(sd / barScore.length)
  const chosen = segmentBars(barStarts, barScore, mu + (options.threshold ?? 0.5) * sd)
  const segs = mergeShortSegments(
    chosen.slice(0, -1).map((b, k) => ({ a: barStarts[b], z: barStarts[chosen[k + 1]] })),
    times,
  )

  // Group segments by average-linkage clustering on pairwise repetition similarity.
  const groupThr = options.groupThreshold ?? 0.35
  const ns = segs.length
  const S = Array.from({ length: ns }, () => new Float64Array(ns))
  for (let s = 0; s < ns; s++)
    for (let t = s + 1; t < ns; t++) {
      const v = segmentSimilarity(feat, sigma2, segs[s].a, segs[s].z, segs[t].a, segs[t].z)
      S[s][t] = v
      S[t][s] = v
    }
  let clusters = segs.map((_, i) => [i])
  for (;;) {
    let bv = groupThr
    let ba = -1
    let bb = -1
    for (let a = 0; a < clusters.length; a++)
      for (let b = a + 1; b < clusters.length; b++) {
        let s = 0
        for (const i of clusters[a]) for (const j of clusters[b]) s += S[i][j]
        s /= clusters[a].length * clusters[b].length
        if (s > bv) {
          bv = s
          ba = a
          bb = b
        }
      }
    if (ba < 0) break
    clusters[ba] = [...clusters[ba], ...clusters[bb]]
    clusters = clusters.filter((_, k) => k !== bb)
  }
  clusters.sort((x, y) => Math.min(...x) - Math.min(...y))
  const groupOf = new Array<number>(ns)
  clusters.forEach((c, g) => c.forEach((i) => (groupOf[i] = g)))
  const eAt = (t0: number, t1: number) => {
    const a = Math.floor(t0 * energy.fps)
    const z = Math.max(a + 1, Math.floor(t1 * energy.fps))
    let s = 0
    let c = 0
    for (let i = a; i < z && i < energy.values.length; i++) {
      s += energy.values[i]
      c++
    }
    return c ? s / c : 0
  }
  const raw = segs.map((s, k) => ({
    start: times[s.a],
    end: times[s.z],
    group: groupOf[k],
    energy: eAt(times[s.a], times[s.z]),
  }))
  options.debug?.({ segments: raw, novelty: nov, barScore })
  const result = labelSections(raw, spec.duration)
  const bars = barStarts.filter((b) => b < n)
  const beatEnergy = Float64Array.from({ length: n }, (_, i) => eAt(times[i], times[i + 1]))
  const passage = repeatedPassage(feat, sigma2, bars, beatEnergy)
  if (passage.length > 0) {
    const round = (t: number) => Math.round(t * 1000) / 1000
    result.chorus = passage.map(({ a, z }) => ({ start: round(times[a]), end: round(times[z]) }))
  }
  return result
}

interface RawSegment {
  start: number
  end: number
  group: number
  energy: number
}

/** Heuristic labels from repetition, position and energy; merges neighbours with equal labels. */
export function labelSections(raw: RawSegment[], duration: number): SongSections {
  const nGroups = Math.max(0, ...raw.map((r) => r.group)) + 1
  const stats = Array.from({ length: nGroups }, (_, g) => {
    const members = raw.filter((r) => r.group === g)
    const dur = members.reduce((s, r) => s + (r.end - r.start), 0)
    const en = members.reduce((s, r) => s + r.energy * (r.end - r.start), 0) / (dur || 1)
    return { g, count: members.length, dur, energy: en, first: members[0]?.start ?? Infinity }
  })
  const songEnergy = raw.reduce((s, r) => s + r.energy * (r.end - r.start), 0) / (duration || 1)
  const repeated = stats.filter((s) => s.count >= 2)
  // Verse -> chorus succession: a group that repeatedly follows another repeated group is the
  // likelier chorus of the pair.
  const follows = new Map<string, number>()
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i].group
    const b = raw[i + 1].group
    if (a !== b) follows.set(`${a}>${b}`, (follows.get(`${a}>${b}`) || 0) + 1)
  }
  let chorusGroup = -1
  let bestScore = -Infinity
  for (const s of repeated) {
    const meanDur = s.dur / s.count
    let succession = 0
    for (const t of repeated) {
      if (t.g === s.g) continue
      if ((follows.get(`${t.g}>${s.g}`) || 0) >= 2) succession += 1
      if ((follows.get(`${s.g}>${t.g}`) || 0) >= 2) succession -= 1
    }
    const last = Math.max(...raw.filter((r) => r.group === s.g).map((r) => r.end))
    const score =
      0.5 * Math.min(s.count, 4) +
      5 * (s.energy - songEnergy) +
      (meanDur >= 10 && meanDur <= 45 ? 0.5 : 0) +
      Math.max(-1, Math.min(1, succession)) +
      (last > duration * 0.7 ? 0.5 : 0) -
      (s.first < 5 ? 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      chorusGroup = s.g
    }
  }
  const labels: SectionLabel[] = raw.map((r) => (r.group === chorusGroup ? 'chorus' : 'verse'))
  const firstChorus = labels.indexOf('chorus')
  const lastChorus = labels.lastIndexOf('chorus')
  // Intro: leading non-chorus segments before the first repeated material, if low energy or short.
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    const isRepeated = stats[r.group].count >= 2
    if (labels[i] === 'chorus') break
    const quiet = r.energy < songEnergy - 0.08
    if (
      (i === 0 && raw.length > 1 && (!isRepeated || r.end - r.start <= 12)) ||
      (i > 0 && labels[i - 1] === 'intro' && quiet && !isRepeated)
    )
      labels[i] = 'intro'
    else break
  }
  // Outro: trailing non-chorus segments after the last chorus that are unrepeated or quiet.
  for (let i = raw.length - 1; i > Math.max(0, lastChorus); i--) {
    const r = raw[i]
    const quiet = r.energy < songEnergy - 0.08
    if (labels[i] === 'chorus') break
    if (stats[r.group].count < 2 || quiet || r.end - r.start <= 12) labels[i] = 'outro'
    else break
  }
  // Bridge: unrepeated, non-edge material after the first chorus and before the last chorus.
  if (firstChorus >= 0) {
    for (let i = firstChorus + 1; i < lastChorus; i++) {
      if (labels[i] === 'verse' && stats[raw[i].group].count < 2 && raw[i].start > duration * 0.4)
        labels[i] = 'bridge'
    }
  }
  const letters = (g: number) => String.fromCharCode(65 + (g % 26))
  const merged: Section[] = []
  for (let i = 0; i < raw.length; i++) {
    const last = merged.at(-1)
    const sec: Section = {
      start: raw[i].start,
      end: raw[i].end,
      label: labels[i],
      group: letters(raw[i].group),
      energy: Math.round(raw[i].energy * 1000) / 1000,
    }
    if (last && last.label === sec.label && (last.group === sec.group || sec.label !== 'chorus')) {
      const d0 = last.end - last.start
      const d1 = sec.end - sec.start
      last.energy = Math.round(((last.energy * d0 + sec.energy * d1) / (d0 + d1)) * 1000) / 1000
      last.end = sec.end
    } else merged.push(sec)
  }
  for (const s of merged) {
    s.start = Math.round(s.start * 1000) / 1000
    s.end = Math.round(s.end * 1000) / 1000
  }
  return {
    version: 1,
    sections: merged,
    chorus: merged.filter((s) => s.label === 'chorus').map((s) => ({ start: s.start, end: s.end })),
  }
}
