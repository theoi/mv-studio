import type { AudioAnalysis, EditCommand, Id } from '../model/index.ts'
import { hasFoundBars } from '../model/queries.ts'
import { JobError, jobs, type JobHandle, type JobRunner } from '../shared/jobs.ts'
import { createWorkerClient, runWorkerCall, type WorkerClient } from '../shared/worker.ts'
import type { DecodedAudio } from './beats/fast.ts'
import { barsOfFour, fitDownbeats } from './beats/grid.ts'
import { decodeAudioFile } from './decode.ts'
import { part } from './jobContext.ts'
import type { RefinedFields } from './song.ts'
import type { AnalysisWorkerApi } from './worker-api.ts'

export type { DecodedAudio }
export { decodeAudioFile } from './decode.ts'

export interface SongAnalysisOptions {
  runner?: JobRunner
  createWorker?: () => Worker
  /** Decodes song files for analyzeAgain and trackAtTempo; defaults to the browser's decoder (main thread only). */
  decode?: (file: Blob) => Promise<DecodedAudio>
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
  private readonly decode: (file: Blob) => Promise<DecodedAudio>

  constructor(options: SongAnalysisOptions = {}) {
    this.runner = options.runner ?? jobs
    this.decode = options.decode ?? ((file) => decodeAudioFile(file))
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL('./analysis.worker.ts', import.meta.url), {
          type: 'module',
          name: 'audio-analysis',
        }))
  }

  private worker(): WorkerClient<AnalysisWorkerApi> {
    // A worker that crashed is replaced on the next call (it no longer holds earlier songs).
    this.client ??= createWorkerClient<AnalysisWorkerApi>(() => this.createWorker())
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

  /**
   * Beat This! refinement: bars and steadier beats. When the worker may no longer hold the song (e.g. after reloading
   * a project), pass its decoded `audio`, or a function returning its file, which is read only if the worker does not
   * hold the song.
   */
  refine(assetId: Id, source?: DecodedAudio | (() => Promise<Blob>)): JobHandle<RefinedFields> {
    return this.runner.run({
      kind: 'analysis.downbeats',
      title: 'Finding bars and refining beats',
      run: async (ctx) => {
        let audio = typeof source === 'function' ? undefined : source
        if (typeof source === 'function' && !(await this.worker().call('holds', { assetId }))) {
          ctx.progress({ stage: 'decode', fraction: 0, message: 'Reading the song' })
          audio = await this.decode(await source())
          ctx.throwIfCancelled()
        }
        return runWorkerCall(
          this.worker(),
          'refineBeats',
          { assetId, audio },
          ctx,
          audio?.channels.map((c) => c.buffer),
        )
      },
    })
  }

  /**
   * Analysis the user asked for: the fast pass, then Beat This! bars and beats, as one job `analysis.song`. Resolves
   * with both combined, for one undoable `setAnalysisCommand` dispatch. If the refinement fails (e.g. its model
   * cannot be downloaded), the fast analysis is returned.
   */
  analyzeAgain(assetId: Id, file: () => Promise<Blob>): JobHandle<AudioAnalysis> {
    return this.runner.run({
      kind: 'analysis.song',
      title: 'Analyzing the song',
      run: async (ctx) => {
        ctx.progress({ stage: 'decode', fraction: 0, message: 'Reading the song' })
        const audio = await this.decode(await file())
        ctx.throwIfCancelled()
        const transfer = audio.channels.map((c) => c.buffer)
        const fast = await runWorkerCall(
          this.worker(),
          'analyzeFast',
          { assetId, audio },
          part(ctx, 0.05, 0.25),
          transfer,
        )
        try {
          const refined = await runWorkerCall(this.worker(), 'refineBeats', { assetId }, part(ctx, 0.25, 1))
          return { ...fast, ...refined }
        } catch (error) {
          if (error instanceof JobError && error.code === 'cancelled') throw error
          return fast
        }
      },
    })
  }

  /**
   * The beats tracked again around a tempo the user tapped (job `analysis.tempo`), for an undoable
   * `analysis.setGrid` edit. `file` is read only when the worker no longer holds the song.
   */
  trackAtTempo(
    assetId: Id,
    bpm: number,
    file: () => Promise<Blob>,
  ): JobHandle<Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'>> {
    return this.runner.run({
      kind: 'analysis.tempo',
      title: 'Following your tempo',
      run: async (ctx) => {
        if (!(await this.worker().call('holds', { assetId }))) {
          ctx.progress({ stage: 'decode', fraction: 0, message: 'Reading the song' })
          const audio = await this.decode(await file())
          ctx.throwIfCancelled()
          const transfer = audio.channels.map((c) => c.buffer)
          return runWorkerCall(
            this.worker(),
            'trackAtTempo',
            { assetId, bpm, audio },
            part(ctx, 0.1, 1),
            transfer,
          )
        }
        return runWorkerCall(this.worker(), 'trackAtTempo', { assetId, bpm }, ctx)
      },
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

const refinedFields = (a: RefinedFields): RefinedFields => ({
  tempo: a.tempo,
  beats: a.beats,
  downbeats: a.downbeats,
  sections: a.sections,
})

/**
 * The edit that applies a refinement of `fast`, the analysis it started from: the beat grid and the sections each
 * change only if the user has not corrected them since. Dispatch with `{ history: 'skip' }`.
 */
export function refinedAnalysisCommand(fast: AudioAnalysis, refined: RefinedFields): EditCommand {
  return {
    type: 'analysis.setRefined',
    assetId: fast.assetId,
    refined: refinedFields(refined),
    baseline: refinedFields(fast),
  }
}

/**
 * The edit that brings the bars of a refinement into `current`, the song's analysis as it is now; `baseline` is the
 * analysis the refinement started from. Untouched detected beats take the refined grid (and the refined sections
 * when `sections` is set, for a refinement right after the first analysis; later the sections may hold the user's
 * edits). Beats the user set (tempo confidence 1) or changed meanwhile are kept, and get the refined bars that fall
 * on them. Null when bars exist already or the refined bars fit none of the beats. Dispatch with
 * `{ history: 'skip' }`.
 */
export function refinedBarsCommand(
  current: AudioAnalysis,
  baseline: AudioAnalysis,
  refined: RefinedFields,
  options: { sections?: boolean } = {},
): EditCommand | null {
  if (hasFoundBars(current) || !refined.downbeats || !hasFoundBars(refined)) return null
  const grid = (a: RefinedFields) => ({ tempo: a.tempo, beats: a.beats, downbeats: a.downbeats })
  const untouched = JSON.stringify(grid(current)) === JSON.stringify(grid(baseline))
  if (untouched && current.tempo?.confidence !== 1) {
    if (options.sections) return refinedAnalysisCommand(baseline, refined)
    return {
      type: 'analysis.setRefined',
      assetId: current.assetId,
      refined: grid(refined),
      baseline: grid(current),
    }
  }
  const fitted = fitDownbeats(current.beats ?? [], refined.downbeats)
  const downbeats = fitted && barsOfFour(current.beats ?? [], fitted)
  if (!downbeats) return null
  return {
    type: 'analysis.setRefined',
    assetId: current.assetId,
    refined: { ...grid(current), downbeats },
    baseline: grid(current),
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
export { chorusEdgesCommand, lyricChorusCommand } from './structure/chorus.ts'
export {
  STEM_MODEL_BYTES,
  StemSeparationService,
  stemEdits,
  type StemSeparationResult,
} from './stems/client.ts'
