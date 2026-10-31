import type { AudioAnalysis, EditCommand, Id } from '../model/index.ts'
import { JobError, jobs, type JobHandle, type JobRunner } from '../shared/jobs.ts'
import { createWorkerClient, runWorkerCall, type WorkerClient } from '../shared/worker.ts'
import type { DecodedAudio } from './beats/fast.ts'
import type { RefinedFields } from './song.ts'
import { mergeRefinedAnalysis } from './song.ts'
import type { AnalysisWorkerApi } from './worker-api.ts'

export type { DecodedAudio }

/**
 * Decodes an audio file on the main thread (OfflineAudioContext is not available in workers). Chrome decodes off
 * the main thread; the result is resampled to `sampleRate`.
 */
export async function decodeAudioFile(data: Blob | ArrayBuffer, sampleRate = 44100): Promise<DecodedAudio> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    const buffer = await ctx.decodeAudioData(bytes)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
      buffer.getChannelData(c).slice(),
    )
    return { sampleRate: buffer.sampleRate, channels }
  } catch (error) {
    throw new JobError('decode', 'This audio file could not be decoded', { cause: error })
  }
}

export interface SongAnalysisOptions {
  runner?: JobRunner
  createWorker?: () => Worker
}

/**
 * Runs song analysis in a dedicated worker as jobs. Typical flow:
 *   const fast = service.analyze(assetId, audio)            // seconds: tempo, beats, sections, energy, features
 *   editor.dispatch(setAnalysisCommand(await fast.promise))
 *   const refined = service.refine(assetId)                 // ~15-60 s: downbeats and refined beats
 *   editor.dispatch(setAnalysisCommand(mergeRefinedAnalysis(current, fastResult, await refined.promise)))
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

export function setAnalysisCommand(analysis: AudioAnalysis): EditCommand {
  return { type: 'analysis.setAudio', analysis }
}

export { mergeRefinedAnalysis }
