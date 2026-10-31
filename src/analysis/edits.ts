/** User corrections to song analysis as undoable `analysis.setGrid` edits (normal dispatches, not skipped). */
import type { EditCommand } from '../model/commands.ts'
import type { AudioAnalysis } from '../model/types.ts'
import { type BeatGrid, makeGrid, rescaleGrid, setDownbeat } from './beats/grid.ts'

export type GridEdit = Extract<EditCommand, { type: 'analysis.setGrid' }>

function gridFromAnalysis(analysis: AudioAnalysis): BeatGrid {
  const beats = analysis.beats ?? []
  const down = new Set(analysis.downbeats ?? [])
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

function gridEdit(assetId: string, grid: BeatGrid): GridEdit {
  return {
    type: 'analysis.setGrid',
    assetId,
    grid: { tempo: { bpm: grid.bpm, confidence: 1 }, beats: grid.beats, downbeats: grid.downbeats },
  }
}

/** Doubles (2) or halves (0.5) the beat level, keeping downbeats. */
export function rescaleTempo(analysis: AudioAnalysis, factor: 2 | 0.5): GridEdit {
  return gridEdit(analysis.assetId, rescaleGrid(gridFromAnalysis(analysis), factor))
}

/** Makes beat `beatIndex` a downbeat and renumbers bars from it (optionally with a new meter). */
export function moveDownbeat(analysis: AudioAnalysis, beatIndex: number, beatsPerBar?: number): GridEdit {
  const grid = gridFromAnalysis(analysis)
  return gridEdit(analysis.assetId, setDownbeat(grid, beatIndex, beatsPerBar ?? grid.beatsPerBar))
}
