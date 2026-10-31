import type { AudioAnalysis } from '../model/types.ts'
import { JobError, type JobProgress } from '../shared/jobs.ts'
import type { WorkerCallContext } from '../shared/worker.ts'
import type { BeatThisLogits, BeatThisModel } from './beats/beatThis.ts'
import type { DecodedAudio } from './beats/fast.ts'
import {
  analyzeSongFast,
  refineSongBeats,
  trackSongAtTempo,
  type RefinedFields,
  type SongState,
} from './song.ts'

/**
 * Share of refineBeats' progress for downloading the Beat This! model when it is not loaded yet; running it takes the
 * rest. Both report 0..1 of their own, so sharing the bar would send it back from 100% after the download.
 */
const MODEL_DOWNLOAD_SHARE = 0.5

/** `p` with its fraction moved into from..to. */
const within = (p: JobProgress, from: number, to: number): JobProgress =>
  p.fraction === undefined ? p : { ...p, fraction: from + p.fraction * (to - from) }

export interface AnalysisWorkerDeps {
  beatThisModel(ctx: WorkerCallContext): Promise<BeatThisModel>
}

/** Worker methods for song analysis. Kept free of worker globals so tests can drive them over a MessageChannel. */
export function createAnalysisApi(deps: AnalysisWorkerDeps) {
  const states = new Map<string, SongState>()
  // Beat This! output outlives a released state (it is ~100 kB a song), so finding bars again skips the network.
  const logits = new Map<string, BeatThisLogits>()
  const keep = (assetId: string, state: SongState) => {
    state.logits ??= logits.get(assetId)
    states.delete(assetId)
    states.set(assetId, state)
    // Two songs at most: each state holds ~20 MB of PCM and spectra.
    while (states.size > 2) states.delete(states.keys().next().value as string)
  }
  const remember = (assetId: string, state: SongState) => {
    if (!state.logits) return
    logits.delete(assetId)
    logits.set(assetId, state.logits)
    while (logits.size > 8) logits.delete(logits.keys().next().value as string)
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
      ctx.progress({ stage: 'downbeats', fraction: 0, message: 'Finding bars and refining beats' })
      let downloaded = false
      const download = {
        signal: ctx.signal,
        progress: (p: JobProgress) => {
          downloaded = true
          ctx.progress(within(p, 0, MODEL_DOWNLOAD_SHARE))
        },
      }
      const { fields } = await refineSongBeats(state, () => deps.beatThisModel(download), {
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(downloaded ? within(p, MODEL_DOWNLOAD_SHARE, 1) : p),
      })
      remember(args.assetId, state)
      return fields
    },

    async trackAtTempo(
      args: { assetId: string; bpm: number; audio?: DecodedAudio },
      ctx: WorkerCallContext,
    ): Promise<Pick<AudioAnalysis, 'tempo' | 'beats' | 'downbeats'>> {
      let state = states.get(args.assetId)
      if (!state) {
        if (!args.audio) throw new JobError('invalid-input', 'Song audio is needed to follow a tempo')
        ctx.progress({ stage: 'spectrum', fraction: 0.1, message: 'Listening to the song' })
        state = analyzeSongFast(args.assetId, args.audio, { signal: ctx.signal }).state
        keep(args.assetId, state)
      }
      ctx.progress({ stage: 'beats', fraction: 0.8, message: 'Following your tempo' })
      return trackSongAtTempo(state, args.bpm, ctx.signal)
    },

    holds(args: { assetId: string }): boolean {
      return states.has(args.assetId)
    },

    release(args: { assetId: string }): boolean {
      return states.delete(args.assetId)
    },
  }
}

export type AnalysisWorkerApi = ReturnType<typeof createAnalysisApi>
