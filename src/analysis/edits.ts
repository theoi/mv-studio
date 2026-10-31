/**
 * User corrections to song analysis: undoable `analysis.setGrid` edits (normal dispatches, not skipped), and the
 * sections the user named kept across a new analysis.
 */
import type { EditCommand } from '../model/commands.ts'
import type { AudioAnalysis, SongSection } from '../model/types.ts'
import { barsOfFour, type BeatGrid, makeGrid, rescaleGrid, setDownbeat } from './beats/grid.ts'
import { isUserSection } from './structure/sections.ts'

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

/**
 * Doubles (2) or halves (0.5) the beat level. Found bars stay bars of four: doubling adds a bar start every four new
 * beats, halving leaves none, since which of each pair of new beats starts a bar is unknown (`barsOfFour`). None are
 * guessed when none were found.
 */
export function rescaleTempo(analysis: AudioAnalysis, factor: 2 | 0.5): GridEdit {
  const grid = rescaleGrid(gridFromAnalysis(analysis), factor)
  const edit = gridEdit(analysis.assetId, grid)
  const bars = edit.grid.downbeats ? barsOfFour(grid.beats, edit.grid.downbeats) : null
  return { ...edit, grid: { ...edit.grid, downbeats: bars ?? undefined } }
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

/** Fresh pieces shorter than this join a fresh neighbour instead of standing alone. */
const MIN_PIECE_SECONDS = 1

/**
 * The sections of a new analysis with the sections the user named in `previous` (`isUserSection`) kept as they were
 * (times, name, id): fresh sections are cut around them, and new pieces get ids no other section has. A kept section
 * takes the repeat group of the fresh section it mostly covers, since the old groups mean nothing in the new analysis.
 */
export function keepUserSections(
  fresh: readonly SongSection[],
  previous: readonly SongSection[],
): SongSection[] {
  const kept = previous.filter(isUserSection)
  if (kept.length === 0) return [...fresh]
  const ids = new Set([...fresh, ...kept].map((s) => s.id))
  const pieceId = (id: string) => {
    let k = 1
    while (ids.has(`${id}.${k}`)) k++
    ids.add(`${id}.${k}`)
    return `${id}.${k}`
  }
  const out: { section: SongSection; kept: boolean }[] = []
  for (const s of fresh) {
    let pieces = [{ start: s.start, end: s.end }]
    for (const k of kept)
      pieces = pieces.flatMap((p) =>
        k.end <= p.start || k.start >= p.end
          ? [p]
          : [
              ...(k.start > p.start ? [{ start: p.start, end: k.start }] : []),
              ...(k.end < p.end ? [{ start: k.end, end: p.end }] : []),
            ],
      )
    pieces.forEach((p, i) =>
      out.push({ section: { ...s, id: i === 0 ? s.id : pieceId(s.id), ...p }, kept: false }),
    )
  }
  for (const k of kept) {
    let group: number | undefined
    let most = 0
    for (const s of fresh) {
      const overlap = Math.min(s.end, k.end) - Math.max(s.start, k.start)
      if (overlap > most) [most, group] = [overlap, s.repeatGroup]
    }
    const section = { ...k }
    if (group === undefined) delete section.repeatGroup
    else section.repeatGroup = group
    out.push({ section, kept: true })
  }
  out.sort((a, b) => a.section.start - b.section.start)
  const result: typeof out = []
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!
    const { section } = cur
    if (!cur.kept && section.end - section.start < MIN_PIECE_SECONDS) {
      const last = result.at(-1)
      const next = out[i + 1]
      if (last && !last.kept && last.section.end === section.start) {
        last.section.end = section.end
        continue
      }
      if (next && !next.kept && next.section.start === section.end) {
        next.section.start = section.start
        continue
      }
    }
    result.push(cur)
  }
  return result.map((r) => r.section)
}
