import { newId } from '../model/factory.ts'
import type { AudioAnalysis, SongSection } from '../model/types.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'
import { ANALYSIS_SAMPLE_RATE, analyzeSpectrum, type SpectralAnalysis } from './frontend.ts'
import { resample } from './dsp/resample.ts'
import { throwIfAborted } from './dsp/stats.ts'
import { toAnalysisMono, trackBeatsFast, type DecodedAudio } from './beats/fast.ts'
import type { BeatGrid } from './beats/grid.ts'
import { refineWithBeatThis } from './beats/refine.ts'
import { BEAT_THIS_SAMPLE_RATE, runBeatThis, type BeatThisModel } from './beats/beatThis.ts'
import {
  analyzeStructure,
  computeEnergyCurve,
  type EnergyCurve,
  type SongSections,
} from './structure/sections.ts'
import { computeAudioFeatures } from './features/features.ts'

/** Stored with results; bump when algorithms change so older analyses can be recomputed. */
export const ANALYZER_VERSION = 'mvs-audio-1'

export interface AnalysisCallbacks {
  signal?: AbortSignal
  onProgress?: (progress: JobProgress) => void
}

/** Intermediate data kept in the worker so beat refinement can reuse it without re-decoding. */
export interface SongState {
  mono: Float32Array
  spec: SpectralAnalysis
  onset: Float32Array
  energy: EnergyCurve
  grid: BeatGrid
}

export function gridFields(grid: BeatGrid): Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'> {
  const top = grid.tempoCandidates[0]?.score ?? 1
  const second = grid.tempoCandidates[1]?.score ?? 0
  const confidence =
    grid.source === 'beat-this'
      ? grid.steady
        ? 0.95
        : 0.8
      : Math.max(0.2, Math.min(0.9, 1 - second / (top || 1)))
  return {
    tempo: { bpm: grid.bpm, confidence: Math.round(confidence * 100) / 100 },
    beats: grid.beats,
    downbeats: grid.downbeats,
  }
}

export function sectionFields(sections: SongSections): SongSection[] {
  return sections.sections.map((s) => ({
    id: newId(),
    start: s.start,
    end: s.end,
    label: s.label,
    repeatGroup: s.group.charCodeAt(0) - 65,
    energy: s.energy,
  }))
}

/** Fast path: tempo, beat grid, provisional downbeats, sections, energy and features in a few seconds. */
export function analyzeSongFast(
  assetId: string,
  audio: DecodedAudio,
  cb: AnalysisCallbacks = {},
): { analysis: AudioAnalysis; state: SongState } {
  const { signal, onProgress } = cb
  if (!audio.channels[0]?.length) throw new JobError('invalid-input', 'The song has no audio')
  onProgress?.({ stage: 'resample', fraction: 0.02, message: 'Preparing audio' })
  const mono = toAnalysisMono(audio)
  throwIfAborted(signal)
  onProgress?.({ stage: 'spectrum', fraction: 0.1, message: 'Listening to the song' })
  const spec = analyzeSpectrum(mono, ANALYSIS_SAMPLE_RATE, signal)
  onProgress?.({ stage: 'beats', fraction: 0.5, message: 'Finding the beat' })
  const { grid, onset } = trackBeatsFast(spec, {}, signal)
  throwIfAborted(signal)
  onProgress?.({ stage: 'sections', fraction: 0.65, message: 'Finding sections' })
  const energy = computeEnergyCurve(spec, onset)
  const sections = analyzeStructure(spec, grid, energy)
  throwIfAborted(signal)
  onProgress?.({ stage: 'features', fraction: 0.8, message: 'Measuring loudness and frequency bands' })
  const features = computeAudioFeatures(mono, ANALYSIS_SAMPLE_RATE, onset, spec.fps)
  const analysis: AudioAnalysis = {
    assetId,
    version: ANALYZER_VERSION,
    ...gridFields(grid),
    sections: sectionFields(sections),
    energy: { rate: energy.fps, values: energy.values },
    features,
  }
  return { analysis, state: { mono, spec, onset, energy, grid } }
}

export type RefinedFields = Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats' | 'sections'>

/** Background step: Beat This! beats and downbeats on the fast grid's tempo level, then sections on real bars. */
export async function refineSongBeats(
  state: SongState,
  model: BeatThisModel,
  cb: AnalysisCallbacks = {},
): Promise<{ fields: RefinedFields; grid: BeatGrid }> {
  const pcm =
    BEAT_THIS_SAMPLE_RATE === ANALYSIS_SAMPLE_RATE
      ? state.mono
      : resample(state.mono, ANALYSIS_SAMPLE_RATE, BEAT_THIS_SAMPLE_RATE)
  const logits = await runBeatThis(model, pcm, {
    signal: cb.signal,
    onProgress: (f) =>
      cb.onProgress?.({ stage: 'downbeats', fraction: f, message: 'Finding bars and refining beats' }),
  })
  const grid = refineWithBeatThis(logits, {
    dspBpm: state.grid.bpm,
    tempoCandidates: state.grid.tempoCandidates,
  })
  const sections = analyzeStructure(state.spec, grid, state.energy)
  state.grid = grid
  return { fields: { ...gridFields(grid), sections: sectionFields(sections) }, grid }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Applies refined beats/sections without discarding user edits: a field is replaced only if the project still
 * holds the fast-path value it was computed from.
 */
export function mergeRefinedAnalysis(
  current: AudioAnalysis,
  fastBaseline: AudioAnalysis,
  refined: RefinedFields,
): AudioAnalysis {
  const next: AudioAnalysis = { ...current }
  const gridUntouched =
    sameJson(current.beats, fastBaseline.beats) &&
    sameJson(current.downbeats, fastBaseline.downbeats) &&
    sameJson(current.tempo, fastBaseline.tempo)
  if (gridUntouched) {
    next.tempo = refined.tempo
    next.beats = refined.beats
    next.downbeats = refined.downbeats
  }
  if (sameJson(current.sections, fastBaseline.sections)) next.sections = refined.sections
  return next
}
