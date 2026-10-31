import { newId } from '../model/factory.ts'
import type { AudioAnalysis, SongSection } from '../model/types.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'
import { ANALYSIS_SAMPLE_RATE, analyzeSpectrum, type SpectralAnalysis } from './frontend.ts'
import { resample } from './dsp/resample.ts'
import { throwIfAborted } from './dsp/stats.ts'
import { toAnalysisMono, trackBeatsFast, type DecodedAudio } from './beats/fast.ts'
import type { BeatGrid } from './beats/grid.ts'
import { barsOfFour, fitDownbeats } from './beats/grid.ts'
import { refineWithBeatThis } from './beats/refine.ts'
import {
  BEAT_THIS_SAMPLE_RATE,
  runBeatThis,
  type BeatThisLogits,
  type BeatThisModel,
} from './beats/beatThis.ts'
import {
  analyzeStructure,
  computeEnergyCurve,
  type EnergyCurve,
  type SongSections,
} from './structure/sections.ts'
import { computeAudioFeatures } from './features/features.ts'
import { AUDIO_CHORUS_CONFIDENCE, withChorus } from './structure/chorus.ts'

/** Stored with results; bump when algorithms change so older analyses can be recomputed. */
export const ANALYZER_VERSION = 'mvs-audio-3'

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
  /** Beat This! output once it ran, so bars can be fitted to a grid the user changes without running it again. */
  logits?: BeatThisLogits
}

/**
 * Tempo and beats of a grid, and its downbeats only when they were found (by Beat This!). The fast path's bar guesses
 * are mostly a beat or two off, so they stay internal (sections use them) and are never stored.
 */
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
    ...(grid.downbeatsReliable ? { downbeats: grid.downbeats } : {}),
  }
}

/** Sections with ids, cut and relabeled so the detected chorus ranges are the choruses. */
export function sectionFields(sections: SongSections, downbeats: readonly number[]): SongSection[] {
  const fields = sections.sections.map((s) => ({
    id: newId(),
    start: s.start,
    end: s.end,
    label: s.label,
    repeatGroup: s.group.charCodeAt(0) - 65,
    energy: s.energy,
  }))
  return withChorus(fields, sections.chorus, downbeats, AUDIO_CHORUS_CONFIDENCE)
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
    sections: sectionFields(sections, grid.downbeats),
    energy: { rate: energy.fps, values: energy.values },
    features,
  }
  return { analysis, state: { mono, spec, onset, energy, grid } }
}

/** How far the tracked tempo may stray from a tempo the user tapped (ratio). */
const TAPPED_TEMPO_RANGE = 1.06

/**
 * The beat grid tracked again around a tempo the user tapped: the period is refined from the audio within 6% of it.
 * The tempo counts as confirmed (confidence 1). Downbeats are the Beat This! bars that fall on the new beats when it
 * already ran for the song, else none (`downbeats` is then explicitly undefined, so the edit removes old bars).
 */
export function trackSongAtTempo(
  state: SongState,
  bpm: number,
  signal?: AbortSignal,
): Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'> {
  const tempo = { minBpm: bpm / TAPPED_TEMPO_RANGE, maxBpm: bpm * TAPPED_TEMPO_RANGE, priorBpm: bpm }
  const { grid } = trackBeatsFast(state.spec, tempo, signal)
  state.grid = grid
  const fitted = state.logits
    ? fitDownbeats(grid.beats, refineWithBeatThis(state.logits, { dspBpm: grid.bpm }).downbeats)
    : null
  const bars = fitted && barsOfFour(grid.beats, fitted)
  return { tempo: { bpm: grid.bpm, confidence: 1 }, beats: grid.beats, downbeats: bars ?? undefined }
}

export type RefinedFields = Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats' | 'sections'>

/**
 * Background step: Beat This! beats and downbeats on the fast grid's tempo level, then sections on real bars. The
 * network runs once per song state; later calls reuse its output.
 */
export async function refineSongBeats(
  state: SongState,
  model: () => Promise<BeatThisModel>,
  cb: AnalysisCallbacks = {},
): Promise<{ fields: RefinedFields; grid: BeatGrid }> {
  if (!state.logits) {
    const pcm =
      BEAT_THIS_SAMPLE_RATE === ANALYSIS_SAMPLE_RATE
        ? state.mono
        : resample(state.mono, ANALYSIS_SAMPLE_RATE, BEAT_THIS_SAMPLE_RATE)
    state.logits = await runBeatThis(await model(), pcm, {
      signal: cb.signal,
      onProgress: (f) =>
        cb.onProgress?.({ stage: 'downbeats', fraction: f, message: 'Finding bars and refining beats' }),
    })
  }
  const grid = refineWithBeatThis(state.logits, {
    dspBpm: state.grid.bpm,
    tempoCandidates: state.grid.tempoCandidates,
  })
  const sections = analyzeStructure(state.spec, grid, state.energy)
  state.grid = grid
  return { fields: { ...gridFields(grid), sections: sectionFields(sections, grid.downbeats) }, grid }
}
