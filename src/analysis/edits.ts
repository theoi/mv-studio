/** User corrections to song analysis as undoable `analysis.setGrid` edits (normal dispatches, not skipped). */
import type { EditCommand } from '../model/commands.ts'
import type { AudioAnalysis } from '../model/types.ts'
import { type BeatGrid, makeGrid, rescaleGrid, setDownbeat } from './beats/grid.ts'

export type GridEdit = Extract<EditCommand, { type: 'analysis.setGrid' }>

function gridFromAnalysis(analysis: AudioAnalysis): BeatGrid {
  const beats = analysis.beats ?? []
  if (!analysis.downbeats?.length) {
    // No bars found yet: counted in fours only so the grid is well formed; gridEdit stores none.
    return makeGrid('dsp', beats, { beatsPerBar: 4, positions: beats.map((_, i) => (i % 4) + 1) }, [], false)
  }
  const down = new Set(analysis.downbeats)
  const downIdx = beats.flatMap((t, i) => (down.has(t) ? [i] : []))
  const gaps = downIdx
    .slice(1)
    .map((d, k) => d - (downIdx[k] as number))
    .sort((a, b) => a - b)
  const beatsPerBar = gaps[gaps.length >> 1] ?? 4
  const first = downIdx[0] ?? 0
  let pos = 0
  const positions = beats.map((t, i) => {
    if (down.has(t)) pos = 1
    else if (i < first) pos = ((((i - first) % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1
    else pos += 1
    return pos
  })
  return makeGrid('dsp', beats, { beatsPerBar, positions }, [], downIdx.length > 0)
}

/** The edit storing `grid`; without bars found its downbeats are removed (explicitly undefined), never guessed. */
function gridEdit(assetId: string, grid: BeatGrid): GridEdit {
  return {
    type: 'analysis.setGrid',
    assetId,
    grid: {
      tempo: { bpm: grid.bpm, confidence: 1 },
      beats: grid.beats,
      downbeats: grid.downbeatsReliable ? grid.downbeats : undefined,
    },
  }
}

/** Doubles (2) or halves (0.5) the beat level, keeping downbeats (and keeping none when none were found). */
export function rescaleTempo(analysis: AudioAnalysis, factor: 2 | 0.5): GridEdit {
  return gridEdit(analysis.assetId, rescaleGrid(gridFromAnalysis(analysis), factor))
}

/**
 * The tempo of the beats as a listener taps it: from the median beat interval, so gaps (a silent intro, a break the
 * beat tracker skipped) do not pull it down the way a fit over all beats does.
 */
function beatLevelBpm(beats: readonly number[]): number {
  const gaps = beats
    .slice(1)
    .map((t, i) => t - (beats[i] as number))
    .sort((a, b) => a - b)
  const median = gaps[gaps.length >> 1]
  return median ? 60 / median : 0
}

/** How close a tapped tempo must be to a beat level of the grid to count as that level. */
const TAPPED_TEMPO_TOLERANCE = 0.04

export type TappedTempoFit = { kind: 'same' } | { kind: 'rescale'; edit: GridEdit } | { kind: 'retrack' }

/**
 * How a tapped tempo fits the beats found: already followed ('same'), followed at twice or half the beat level (an
 * instant 'rescale' edit), or not at all ('retrack': track the beats again at that tempo).
 */
export function fitTappedTempo(analysis: AudioAnalysis, bpm: number): TappedTempoFit {
  const current = beatLevelBpm(analysis.beats ?? [])
  if (!current) return { kind: 'retrack' }
  for (const level of [1, 2, 0.5] as const) {
    if (Math.abs(Math.log((current * level) / bpm)) > Math.log1p(TAPPED_TEMPO_TOLERANCE)) continue
    return level === 1 ? { kind: 'same' } : { kind: 'rescale', edit: rescaleTempo(analysis, level) }
  }
  return { kind: 'retrack' }
}

/** Makes beat `beatIndex` a downbeat and renumbers bars from it (optionally with a new meter). */
export function moveDownbeat(analysis: AudioAnalysis, beatIndex: number, beatsPerBar?: number): GridEdit {
  const grid = gridFromAnalysis(analysis)
  return gridEdit(analysis.assetId, setDownbeat(grid, beatIndex, beatsPerBar ?? grid.beatsPerBar))
}
