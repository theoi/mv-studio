/**
 * Where auto-cut cuts: shot spans on the song's beat grid, paced by the song's structure. The grid, section
 * coverage, per-section pace and phrased cut times come from the director's planner helpers, so both cut the same
 * way.
 */
import { energyScale, type SectionInfo, type SongInfo } from '../../director/inputs.ts'
import type { Pace } from '../../director/plan.ts'
import { paceFor } from '../../director/rules.ts'
import {
  beatGrid,
  beatsPerCut,
  cutTimes,
  MIN_SHOT,
  phrasedCutTimes,
  sectionsFor,
  type BeatGrid,
} from '../../director/timing.ts'
import { hasFoundBars } from '../../model/queries.ts'
import type { Id, Seconds } from '../../model/types.ts'
import type { TimeRange } from '../types.ts'

export type AutoCutPace = 'beat' | '2-beats' | 'bar' | '2-bars' | 'phrase'
/** Which grid lines a cut may land on: any beat, bar starts only, or section boundaries only. */
export type AutoCutOn = 'beats' | 'downbeats' | 'sections'

const PACE_BEATS: Record<AutoCutPace, number> = { beat: 1, '2-beats': 2, bar: 4, '2-bars': 8, phrase: 16 }
/** The director's pace with the same beats per shot, which becomes the verse pace when following the song. */
const DIRECTOR_PACE: Record<AutoCutPace, Pace> = {
  beat: 'very-fast',
  '2-beats': 'fast',
  bar: 'medium',
  '2-bars': 'slow',
  phrase: 'very-slow',
}
const EPS = 1e-3

export interface CutSpan {
  start: Seconds
  end: Seconds
  sectionId: Id
  /** Section energy, 0..1 within the song. */
  energy: number
}

export interface RhythmOptions {
  pace: AutoCutPace
  /** Pace by song structure and energy (see `beatsPerShot`), phrased bar by bar; else one even pace. */
  followEnergy: boolean
  cutOn: AutoCutOn
  range: TimeRange
  /** Timeline ranges to leave alone (clips the user made on the auto-cut track). */
  avoid?: readonly TimeRange[]
  /** Longest shot the footage can fill; longer spans are split on bar lines. */
  maxShot?: Seconds
}

export interface Rhythm {
  spans: CutSpan[]
  grid: BeatGrid
  sections: SectionInfo[]
}

/**
 * Beats per shot in a section. Following the song, it is the director's pace for the section's role with the chosen
 * pace as the verse pace: choruses a step faster, intros, bridges and outros a step slower, other sections by their
 * energy, and energy moves a role one step at most. Otherwise every section gets the chosen pace.
 */
export function beatsPerShot(
  pace: AutoCutPace,
  section: Pick<SectionInfo, 'label' | 'energy'>,
  options: { followEnergy: boolean; cutOn: AutoCutOn; grid: Pick<BeatGrid, 'beatLength' | 'bpm'> },
): number {
  const { beatLength, bpm } = options.grid
  let k = options.followEnergy
    ? beatsPerCut(paceFor('beat-cut', section, bpm, false, DIRECTOR_PACE[pace]), beatLength)
    : PACE_BEATS[pace]
  if (options.cutOn === 'downbeats') k = Math.max(4, Math.ceil(k / 4) * 4)
  while (k * beatLength < MIN_SHOT) k *= 2
  return k
}

/** Cut times in [start, end) on bar starts, every `bars` bars, counted from `start` when it is on a bar. */
function barCuts(start: Seconds, end: Seconds, bars: number, grid: BeatGrid): Seconds[] {
  const minShot = Math.max(MIN_SHOT, grid.beatLength * 0.75)
  const inside = grid.downbeats.filter((d) => d > start + EPS && d < end - EPS)
  const onBar = grid.downbeats.some((d) => Math.abs(d - start) < grid.beatLength / 4)
  const cuts = [start]
  for (let i = onBar ? bars - 1 : 0; i < inside.length; i += bars) {
    const t = inside[i] as number
    if (t - (cuts[cuts.length - 1] as number) >= minShot && end - t >= minShot) cuts.push(t)
  }
  return cuts
}

/** Splits a span longer than `max` on the bar lines (else beats) closest to an even division. */
function splitLong(span: CutSpan, max: Seconds, grid: BeatGrid): CutSpan[] {
  const length = span.end - span.start
  if (!(length > max + EPS)) return [span]
  const parts = Math.ceil(length / max)
  const lines = hasFoundBars(grid) ? grid.downbeats : grid.beats
  const cuts = [span.start]
  for (let i = 1; i < parts; i++) {
    const ideal = span.start + (length * i) / parts
    const last = cuts[cuts.length - 1] as number
    const near = lines
      .filter((t) => t > last + MIN_SHOT && t < span.end - MIN_SHOT && t - last <= max + EPS)
      .reduce<number | undefined>(
        (best, t) => (best === undefined || Math.abs(t - ideal) < Math.abs(best - ideal) ? t : best),
        undefined,
      )
    cuts.push(near ?? Math.min(ideal, last + max))
  }
  return cuts.map((start, i) => ({
    ...span,
    start,
    end: i + 1 < cuts.length ? (cuts[i + 1] as number) : span.end,
  }))
}

/** `spans` minus `avoid`. Leftovers shorter than a shot join the shot before them when they touch it. */
function subtract(spans: CutSpan[], avoid: readonly TimeRange[]): CutSpan[] {
  if (!avoid.length) return spans
  const sorted = [...avoid].sort((a, b) => a.start - b.start)
  const out: CutSpan[] = []
  for (const span of spans) {
    let pieces = [span]
    for (const a of sorted) {
      pieces = pieces.flatMap((p) => {
        if (a.end <= p.start + EPS || a.start >= p.end - EPS) return [p]
        const kept: CutSpan[] = []
        if (a.start > p.start + EPS) kept.push({ ...p, end: a.start })
        if (a.end < p.end - EPS) kept.push({ ...p, start: a.end })
        return kept
      })
    }
    for (const piece of pieces) {
      const prev = out[out.length - 1]
      if (piece.end - piece.start >= MIN_SHOT) out.push(piece)
      else if (prev && Math.abs(prev.end - piece.start) < EPS) prev.end = piece.end
    }
  }
  return out
}

/** Shot spans covering `range`, cut on the grid the options ask for. */
export function cutSpans(song: SongInfo, options: RhythmOptions): Rhythm {
  const grid = beatGrid(song)
  const sections = sectionsFor(song, grid)
  const { range } = options
  const energyAt = options.followEnergy ? energyScale(song) : undefined
  const ks = sections.map((s) =>
    beatsPerShot(options.pace, s, { followEnergy: options.followEnergy, cutOn: options.cutOn, grid }),
  )
  let spans: CutSpan[] = []
  for (const [i, section] of sections.entries()) {
    const start = Math.max(section.start, range.start)
    const end = Math.min(section.end, range.end)
    if (end - start < EPS) continue
    const k = ks[i] as number
    // Speed up through the last bar when the next section cuts faster, as an editor leads into a chorus.
    const lift = options.followEnergy && section.end <= range.end + EPS && (ks[i + 1] ?? k) < k
    const cuts =
      options.cutOn === 'sections'
        ? [start]
        : options.cutOn === 'downbeats' && hasFoundBars(grid)
          ? barCuts(start, end, k / 4, grid)
          : options.followEnergy
            ? phrasedCutTimes(start, end, k, grid, { ...(energyAt ? { energyAt } : {}), lift })
            : cutTimes(start, end, k, grid)
    cuts.forEach((t, i) => {
      spans.push({
        start: t,
        end: i + 1 < cuts.length ? (cuts[i + 1] as number) : end,
        sectionId: section.id,
        energy: section.energy,
      })
    })
  }
  if (options.maxShot !== undefined && Number.isFinite(options.maxShot))
    spans = spans.flatMap((s) => splitLong(s, options.maxShot as number, grid))
  return { spans: subtract(spans, options.avoid ?? []), grid, sections }
}
