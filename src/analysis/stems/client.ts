import type { Asset, EditCommand, Id, StemName } from '../../model/index.ts'
import { jobs, type JobHandle, type JobRunner } from '../../shared/jobs.ts'
import { createWorkerClient, runWorkerCall } from '../../shared/worker.ts'
import type { MediaStore } from '../../media/types.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { DEMUCS_MODEL } from '../models.ts'
import type { StemSeparationResult, StemsWorkerApi } from './worker-api.ts'

export type { StemSeparationResult }

/** Download size of the stem model, for the opt-in prompt. */
export const STEM_MODEL_BYTES = DEMUCS_MODEL.files.model?.bytes ?? 0

export interface StemSeparationOptions {
  runner?: JobRunner
  createWorker?: () => Worker
}

/**
 * Opt-in stem separation (vocals, drums, bass, other) as a job. Each run uses a fresh worker that is terminated
 * afterwards, which frees the model's memory (over 1 GB) and makes cancelling immediate.
 */
export class StemSeparationService {
  private readonly runner: JobRunner
  private readonly createWorker: () => Worker

  constructor(options: StemSeparationOptions = {}) {
    this.runner = options.runner ?? jobs
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL('./stems.worker.ts', import.meta.url), {
          type: 'module',
          name: 'stem-separation',
        }))
  }

  /** Separates 44.1 kHz audio (other rates are resampled). The channel buffers are transferred to the worker. */
  separate(audio: DecodedAudio): JobHandle<StemSeparationResult> {
    return this.runner.run({
      kind: 'analysis.stems',
      title: 'Separating stems',
      run: async (ctx) => {
        const client = createWorkerClient<StemsWorkerApi>(this.createWorker())
        try {
          return await runWorkerCall(
            client,
            'separate',
            { audio },
            ctx,
            audio.channels.map((c) => c.buffer),
          )
        } finally {
          client.terminate()
        }
      },
    })
  }
}

const STEM_LABELS: Record<StemName, string> = {
  vocals: 'vocals',
  drums: 'drums',
  bass: 'bass',
  other: 'other',
}

/**
 * Stores separated stems in the media store and returns the edits that add them as assets and attach them, with
 * their features, to the song's analysis. Dispatch them with `{ history: 'skip' }`: they write only the stems, so
 * edits made during the separation are kept.
 */
export async function stemEdits(
  result: StemSeparationResult,
  song: Pick<Asset, 'id' | 'name'>,
  store: Pick<MediaStore, 'storeBlob'>,
): Promise<EditCommand[]> {
  const base = song.name.replace(/\.[^.]+$/, '')
  const commands: EditCommand[] = []
  const stems: Partial<Record<StemName, Id>> = {}
  for (const stem of result.stems) {
    const blob = new Blob([stem.audio.data], { type: stem.audio.mimeType })
    const asset = await store.storeBlob(blob, {
      kind: 'audio',
      name: `${base} (${STEM_LABELS[stem.name]})${stem.audio.extension}`,
      origin: { type: 'stem', parentAssetId: song.id },
    })
    stems[stem.name] = asset.id
    commands.push({ type: 'asset.add', asset })
  }
  commands.push({ type: 'analysis.setStems', assetId: song.id, stems, stemFeatures: result.stemFeatures })
  return commands
}
