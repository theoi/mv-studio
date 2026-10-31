import type { AudioAnalysis, EditCommand, Id } from '../model/index.ts'
import { jobs, type JobHandle, type JobRunner } from '../shared/jobs.ts'
import { createWorkerClient, runWorkerCall, type WorkerClient } from '../shared/worker.ts'
import type { DecodedAudio } from './beats/fast.ts'
import type { RefinedFields } from './song.ts'
import type { AnalysisWorkerApi } from './worker-api.ts'

export type { DecodedAudio }
export { decodeAudioFile } from './decode.ts'

export interface SongAnalysisOptions {
  runner?: JobRunner
  createWorker?: () => Worker
}

/**
 * Runs song analysis in a dedicated worker as jobs. Typical flow:
 *   const fast = service.analyze(assetId, audio)            // seconds: tempo, beats, sections, energy, features
 *   const fastResult = await fast.promise
 *   editor.dispatch(setAnalysisCommand(fastResult), { history: 'skip' })
 *   const refined = service.refine(assetId)                 // ~15-60 s: downbeats and refined beats
 *   editor.dispatch(refinedAnalysisCommand(fastResult, await refined.promise), { history: 'skip' })
 */
export class SongAnalysisService {
  private client: WorkerClient<AnalysisWorkerApi> | undefined
  private readonly runner: JobRunner
  private readonly createWorker: () => Worker

  constructor(options: SongAnalysisOptions = {}) {
    this.runner = options.runner ?? jobs
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL('./analysis.worker.ts', import.meta.url), {
          type: 'module',
          name: 'audio-analysis',
        }))
  }

  private worker(): WorkerClient<AnalysisWorkerApi> {
    this.client ??= createWorkerClient<AnalysisWorkerApi>(this.createWorker())
    return this.client
  }

  /** Fast analysis. The audio's channel buffers are transferred to the worker (they become unusable here). */
  analyze(assetId: Id, audio: DecodedAudio): JobHandle<AudioAnalysis> {
    return this.runner.run({
      kind: 'analysis.song',
      title: 'Analyzing the song',
      run: (ctx) =>
        runWorkerCall(
          this.worker(),
          'analyzeFast',
          { assetId, audio },
          ctx,
          audio.channels.map((c) => c.buffer),
        ),
    })
  }

  /** Beat This! refinement. Pass `audio` if the worker may no longer hold the song (e.g. after reloading a project). */
  refine(assetId: Id, audio?: DecodedAudio): JobHandle<RefinedFields> {
    return this.runner.run({
      kind: 'analysis.downbeats',
      title: 'Finding bars and refining beats',
      run: (ctx) =>
        runWorkerCall(
          this.worker(),
          'refineBeats',
          { assetId, audio },
          ctx,
          audio?.channels.map((c) => c.buffer),
        ),
    })
  }

  /** Frees the worker's copy of a song once no more analysis is needed for it. */
  async release(assetId: Id): Promise<void> {
    if (this.client) await this.client.call('release', { assetId })
  }

  dispose(): void {
    this.client?.terminate()
    this.client = undefined
  }
}

/**
 * The edit that stores a fresh analysis (stems already attached are kept). Dispatch the first analysis after import
 * with `{ history: 'skip' }`; a re-analysis the user asks for is a normal dispatch, so undo brings back their
 * corrections.
 */
export function setAnalysisCommand(analysis: AudioAnalysis): EditCommand {
  const detected = { ...analysis }
  delete detected.stems
  delete detected.stemFeatures
  return { type: 'analysis.setDetected', analysis: detected }
}

/**
 * The edit that applies a refinement of `fast`, the analysis it started from: the beat grid and the sections each
 * change only if the user has not corrected them since. Dispatch with `{ history: 'skip' }`.
 */
export function refinedAnalysisCommand(fast: AudioAnalysis, refined: RefinedFields): EditCommand {
  const fields = (a: RefinedFields): RefinedFields => ({
    tempo: a.tempo,
    beats: a.beats,
    downbeats: a.downbeats,
    sections: a.sections,
  })
  return {
    type: 'analysis.setRefined',
    assetId: fast.assetId,
    refined: fields(refined),
    baseline: fields(fast),
  }
}
export {
  LyricsService,
  setLyricsCommand,
  WHISPER_MODELS,
  type LyricsDeps,
  type LyricsEstimate,
  type LyricsRequest,
  type LyricsResult,
  type WhisperSize,
} from './lyrics/client.ts'
export { lyricChorusCommand } from './structure/chorus.ts'
export {
  STEM_MODEL_BYTES,
  StemSeparationService,
  stemEdits,
  type StemSeparationResult,
} from './stems/client.ts'
