import type { ProjectEditor } from '../../model/editor.ts'
import type { Asset, EditCommand, Id, Project, StemName } from '../../model/index.ts'
import { detectCapabilities } from '../../shared/capabilities.ts'
import { JobError, jobs, type JobContext, type JobHandle, type JobRunner } from '../../shared/jobs.ts'
import { modelCache, type ModelDevice } from '../../shared/models.ts'
import { createWorkerClient, runWorkerCall } from '../../shared/worker.ts'
import type { MediaStore } from '../../media/types.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { decodeAudioFile } from '../decode.ts'
import { DEMUCS_MODEL } from '../models.ts'
import { DEMUCS_SAMPLE_RATE } from './demucs.ts'
import { stemDevice } from './device.ts'
import type { StemSeparationResult, StemsWorkerApi } from './worker-api.ts'

export type { StemSeparationResult }

/** Download size of the stem model, for the opt-in prompt. */
export const STEM_MODEL_BYTES = DEMUCS_MODEL.files.model?.bytes ?? 0

/**
 * Separation seconds per second of song, measured with WASM threads on a 4-core laptop. The hardware-GPU figure is an
 * estimate until measured on real GPUs.
 */
const SEPARATE_SECONDS_PER_SECOND: Record<ModelDevice, number> = { wasm: 1.1, webgpu: 0.5 }

/**
 * How much more memory the tab holds at the peak of a separation with WASM threads: the renderer's resident memory
 * rose by 2.5 GB for an 8 s song and 2.6 GB for a 3 min song (Chromium, 4 threads), so song length barely matters.
 */
const STEM_PEAK_MEMORY_BYTES = 2.6e9

/** Separation seconds per second of song on this device. */
export async function separateRate(): Promise<number> {
  return SEPARATE_SECONDS_PER_SECOND[stemDevice(await detectCapabilities())]
}

/** What separating a song's stems will download and roughly how long it takes, shown before it starts. */
export interface StemsEstimate {
  /** The stem model's size when it is not cached yet, else 0. */
  downloadBytes: number
  /** Processing time on this device once the model is downloaded, in seconds. */
  seconds: number
  /** Extra memory the tab needs at the peak of the separation. */
  memoryBytes: number
  device: ModelDevice
}

/** Where the song is read and the stems are stored. `getFile` may serve generated media, such as sample songs. */
export interface StemStore extends Pick<MediaStore, 'storeBlob'> {
  getFile(asset: Asset): Promise<Blob>
}

export interface StemDeps {
  editor: Pick<ProjectEditor, 'getProject' | 'dispatch'>
  store: StemStore
}

export interface StemSeparationOptions {
  runner?: JobRunner
  createWorker?: () => Worker
  /** Decodes audio files; defaults to the browser's decoder (main thread only). */
  decode?: (file: Blob, sampleRate: number) => Promise<DecodedAudio>
}

/**
 * Opt-in stem separation (vocals, drums, bass, other) as a job. Each run uses a fresh worker that is terminated
 * afterwards, which frees the model's memory (about 2.6 GB at the peak) and makes cancelling immediate. Typical flow:
 *   const estimate = await service.estimate(project, songId)   // download size and time, for the confirmation
 *   await service.separateSong(songId, { editor, store }).promise
 */
export class StemSeparationService {
  private readonly runner: JobRunner
  private readonly createWorker: () => Worker
  private readonly decode: (file: Blob, sampleRate: number) => Promise<DecodedAudio>

  constructor(options: StemSeparationOptions = {}) {
    this.runner = options.runner ?? jobs
    this.createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL('./stems.worker.ts', import.meta.url), {
          type: 'module',
          name: 'stem-separation',
        }))
    this.decode = options.decode ?? decodeAudioFile
  }

  async estimate(project: Project, songId: Id): Promise<StemsEstimate> {
    const duration = songAsset(project, songId).duration ?? 0
    const urls = Object.values(DEMUCS_MODEL.files).map((f) => f.url)
    const cached = (await Promise.all(urls.map((url) => modelCache.has(url)))).every(Boolean)
    const device = stemDevice(await detectCapabilities())
    return {
      downloadBytes: cached ? 0 : STEM_MODEL_BYTES,
      seconds: Math.ceil(duration * SEPARATE_SECONDS_PER_SECOND[device]),
      memoryBytes: STEM_PEAK_MEMORY_BYTES,
      device,
    }
  }

  /**
   * Separates the song's stems as job \`analysis.stems\` and attaches them to its analysis without an undo step (see
   * \`stemEdits\`). Stages: download, decode, separate, features, encode, save.
   */
  separateSong(songId: Id, deps: StemDeps): JobHandle<StemSeparationResult> {
    return this.runner.run({
      kind: 'analysis.stems',
      title: 'Separating stems',
      run: (ctx) => this.separateSongIn(songId, deps, ctx),
    })
  }

  /** Like \`separateSong\`, as a step of an existing job. */
  async separateSongIn(songId: Id, deps: StemDeps, ctx: JobContext): Promise<StemSeparationResult> {
    const song = songAsset(deps.editor.getProject(), songId)
    ctx.progress({ stage: 'decode', fraction: 0, message: 'Reading the song' })
    const audio = await this.decode(await deps.store.getFile(song), DEMUCS_SAMPLE_RATE)
    const result = await this.separateIn(audio, ctx)
    ctx.progress({ stage: 'save', message: 'Saving stems with the project' })
    const edits = await stemEdits(result, song, deps.store)
    ctx.throwIfCancelled()
    songAsset(deps.editor.getProject(), songId)
    deps.editor.dispatch(edits, { history: 'skip' })
    ctx.progress({ stage: 'save', fraction: 1, message: 'Saving stems with the project' })
    return result
  }

  /** Separates decoded audio (44.1 kHz; other rates are resampled) as a job. The channel buffers are transferred. */
  separate(audio: DecodedAudio): JobHandle<StemSeparationResult> {
    return this.runner.run({
      kind: 'analysis.stems',
      title: 'Separating stems',
      run: (ctx) => this.separateIn(audio, ctx),
    })
  }
  /** Like `separate`, as a step of an existing job. */
  async separateIn(audio: DecodedAudio, ctx: JobContext): Promise<StemSeparationResult> {
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

function songAsset(project: Project, songId: Id): Asset {
  const song = project.assets[songId]
  if (!song) throw new JobError('invalid-input', 'The song is no longer in the project')
  return song
}
