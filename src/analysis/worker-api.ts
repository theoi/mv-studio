import type { AudioAnalysis } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import type { WorkerCallContext } from '../shared/worker.ts'
import type { BeatThisModel } from './beats/beatThis.ts'
import type { DecodedAudio } from './beats/fast.ts'
import { analyzeSongFast, refineSongBeats, type RefinedFields, type SongState } from './song.ts'

export interface AnalysisWorkerDeps {
  beatThisModel(ctx: WorkerCallContext): Promise<BeatThisModel>
}

/** Worker methods for song analysis. Kept free of worker globals so tests can drive them over a MessageChannel. */
export function createAnalysisApi(deps: AnalysisWorkerDeps) {
  const states = new Map<string, SongState>()
  const keep = (assetId: string, state: SongState) => {
    states.delete(assetId)
    states.set(assetId, state)
    // Two songs at most: each state holds ~20 MB of PCM and spectra.
    while (states.size > 2) states.delete(states.keys().next().value as string)
  }
  return {
    async analyzeFast(
      args: { assetId: string; audio: DecodedAudio },
      ctx: WorkerCallContext,
    ): Promise<AudioAnalysis> {
      const { analysis, state } = analyzeSongFast(args.assetId, args.audio, {
        signal: ctx.signal,
        onProgress: ctx.progress,
      })
      keep(args.assetId, state)
      return analysis
    },

    async refineBeats(
      args: { assetId: string; audio?: DecodedAudio },
      ctx: WorkerCallContext,
    ): Promise<RefinedFields> {
      let state = states.get(args.assetId)
      if (!state) {
        if (!args.audio) throw new JobError('invalid-input', 'Song audio is needed to refine beats')
        state = analyzeSongFast(args.assetId, args.audio, { signal: ctx.signal }).state
        keep(args.assetId, state)
      }
      const model = await deps.beatThisModel(ctx)
      ctx.progress({ stage: 'downbeats', fraction: 0, message: 'Finding bars and refining beats' })
      const { fields } = await refineSongBeats(state, model, { signal: ctx.signal, onProgress: ctx.progress })
      return fields
    },

    release(args: { assetId: string }): boolean {
      return states.delete(args.assetId)
    },
  }
}

export type AnalysisWorkerApi = ReturnType<typeof createAnalysisApi>
