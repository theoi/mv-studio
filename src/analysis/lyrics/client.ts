import type { ProjectEditor } from '../../model/editor.ts'
import type { Asset, EditCommand, Id, LyricsDoc, Project } from '../../model/index.ts'
import type { MediaStore } from '../../media/types.ts'
import { detectCapabilities } from '../../shared/capabilities.ts'
import { JobError, jobs, type JobContext, type JobHandle, type JobRunner } from '../../shared/jobs.ts'
import { modelCache, type ModelDescriptor } from '../../shared/models.ts'
import { createWorkerClient, runWorkerCall, type WorkerClient } from '../../shared/worker.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { decodeAudioFile } from '../decode.ts'
import { DEMUCS_MODEL, WAV2VEC2_MODEL, WHISPER_MODELS, whisperFileUrls, type WhisperSize } from '../models.ts'
import { StemSeparationService, stemEdits } from '../stems/client.ts'
import { DEMUCS_SAMPLE_RATE } from '../stems/demucs.ts'
import { stemDevice } from '../stems/device.ts'
import { lyricChorusCommand } from '../structure/chorus.ts'
import { realignFrom, realignLine, type CtcVocabulary } from './align.ts'
import type { CtcEmissions } from './ctc.ts'
import { toLyricsDoc } from './doc.ts'
import { parseLyricsText } from './text.ts'
import { CTC_SAMPLE_RATE } from './wav2vec2.ts'
import type { LyricsWorkerApi } from './worker-api.ts'

export { WHISPER_MODELS, type WhisperSize }

/**
 * Pasted lyrics to time, or a draft written by Whisper. `language` is a Whisper code such as 'en', detected on the
 * vocals when omitted.
 */
export type LyricsRequest =
  { kind: 'time'; text: string } | { kind: 'draft'; language?: string; size?: WhisperSize }

export interface LyricsResult {
  doc: LyricsDoc
  /** Drafts: the language sung, and the detection confidence (0..1) when it was detected. */
  language?: string
  languageProbability?: number
  /**
   * Relabels the song's sections so the lyrics' repeated lines are the chorus (see `lyricChorusCommand`); null when
   * nothing repeats. Dispatch it with `{ history: 'skip' }` together with the lyrics.
   */
  chorus: EditCommand | null
}

/** What `run` will download and roughly how long it will take, for the one confirmation before it starts. */
export interface LyricsEstimate {
  /** The song has no stems yet, so they are separated first (and kept). */
  separatesStems: boolean
  /** Models still to download; cached ones are left out. */
  downloads: { name: string; bytes: number }[]
  downloadBytes: number
  /** Processing time on this device once the models are downloaded, in seconds. */
  seconds: number
}

export interface LyricsDeps {
  editor: Pick<ProjectEditor, 'getProject' | 'dispatch'>
  store: Pick<MediaStore, 'getFile' | 'storeBlob'>
}

export interface LyricsServiceOptions {
  runner?: JobRunner
  createWorker?: () => Worker
  stems?: StemSeparationService
  /** Decodes audio files; defaults to the browser's decoder (main thread only). */
  decode?: (file: Blob, sampleRate: number) => Promise<DecodedAudio>
}

/**
 * Processing seconds per second of song, measured with WASM threads on a 4-core laptop. Stem separation on a
 * hardware GPU is an estimate until measured on real GPUs.
 */
const SECONDS_PER_SECOND = { separate: { wasm: 1.1, webgpu: 0.5 }, align: 0.25, transcribe: 0.8 }
const DRAFT_SIZE: WhisperSize = 'small'

interface Emissions {
  em: CtcEmissions
  vocab: CtcVocabulary
  /** The vocals asset the emissions were computed from. */
  vocalsId: Id
}

/**
 * Lyrics as one job on the song's vocals stem: separating stems first when the song has none (stored as stems
 * without an undo step), then timing pasted lyrics or drafting them with Whisper, with word timings. Each worker is
 * terminated afterwards, which frees the models' memory. The aligner's per-frame output is kept for each song so
 * dragged words and edited lines re-align without the model.
 */
export class LyricsService {
  private readonly runner: JobRunner
  private readonly createWorker: () => Worker
  private readonly stems: StemSeparationService
  private readonly decode: (file: Blob, sampleRate: number) => Promise<DecodedAudio>
  private readonly emissions = new Map<Id, Emissions>()

  constructor(options: LyricsServiceOptions = {}) {
    this.runner = options.runner ?? jobs
    this.createWorker =
      options.createWorker ??
      (() => new Worker(new URL('./lyrics.worker.ts', import.meta.url), { type: 'module', name: 'lyrics' }))
    this.stems = options.stems ?? new StemSeparationService({ runner: this.runner })
    this.decode = options.decode ?? decodeAudioFile
  }

  async estimate(
    project: Project,
    songId: Id,
    request: { kind: LyricsRequest['kind']; size?: WhisperSize },
  ): Promise<LyricsEstimate> {
    const song = songAsset(project, songId)
    const separatesStems = !vocalsAsset(project, songId)
    const whisper = WHISPER_MODELS[request.kind === 'draft' ? (request.size ?? DRAFT_SIZE) : DRAFT_SIZE]
    const models = [
      ...(separatesStems ? [modelFiles(DEMUCS_MODEL)] : []),
      modelFiles(WAV2VEC2_MODEL),
      ...(request.kind === 'draft'
        ? [{ name: whisper.name, bytes: whisper.bytes, urls: whisperFileUrls(whisper) }]
        : []),
    ]
    const cached = await Promise.all(
      models.map(async (m) => (await Promise.all(m.urls.map(isCached))).every(Boolean)),
    )
    const downloads = models.filter((_, i) => !cached[i]).map(({ name, bytes }) => ({ name, bytes }))
    const separate = separatesStems ? await separateRate() : 0
    return {
      separatesStems,
      downloads,
      downloadBytes: downloads.reduce((sum, d) => sum + d.bytes, 0),
      seconds: Math.ceil((song.duration ?? 0) * (separate + lyricsRate(request.kind))),
    }
  }

  /** Times pasted lyrics (one line per lyric line; "[Chorus]" style markers are dropped) or drafts them. */
  run(songId: Id, request: LyricsRequest, deps: LyricsDeps): JobHandle<LyricsResult> {
    return this.runner.run({
      kind: 'analysis.lyrics',
      title: request.kind === 'time' ? 'Timing lyrics' : 'Drafting lyrics',
      run: async (ctx) => {
        const lines =
          request.kind === 'time' ? parseLyricsText(request.text).map((l) => ({ text: l.text })) : []
        if (request.kind === 'time' && lines.length === 0)
          throw new JobError('invalid-input', 'There are no lyrics to time')
        const { vocals, vocalsId, rest } = await this.vocals(songId, deps, ctx, lyricsRate(request.kind))
        if (request.kind === 'time') {
          const cached = this.emissions.get(songId)
          const emissions = cached?.vocalsId === vocalsId ? cached.em : undefined
          const result = await this.call((c) => runWorkerCall(c, 'align', { vocals, lines, emissions }, rest))
          this.emissions.set(songId, { em: result.emissions, vocab: result.vocab, vocalsId })
          const doc: LyricsDoc = { audioAssetId: songId, source: 'pasted', lines: result.lines }
          return { doc, chorus: chorusFor(deps, songId, doc) }
        }
        const size = request.size ?? DRAFT_SIZE
        const result = await this.call((c) =>
          runWorkerCall(c, 'transcribe', { vocals, language: request.language, size }, rest),
        )
        this.emissions.set(songId, { em: result.emissions, vocab: result.vocab, vocalsId })
        const doc = toLyricsDoc(result.words, {
          boundaries: result.segmentStarts,
          source: 'transcribed',
          audioAssetId: songId,
        })
        return {
          doc,
          language: result.language,
          languageProbability: result.languageProbability,
          chorus: chorusFor(deps, songId, doc),
        }
      },
    })
  }

  /** Whether words of this song can be re-aligned without running the aligner again. */
  canRealign(audioAssetId?: Id): boolean {
    return this.emissions.has(audioAssetId ?? '')
  }

  /**
   * Pins word `wordIndex` of line `lineIndex` at `time` (song seconds) and re-aligns the words after it. Returns
   * undefined when the song has not been aligned in this session (see `canRealign`).
   */
  realignFrom(doc: LyricsDoc, lineIndex: number, wordIndex: number, time: number): LyricsDoc | undefined {
    const e = this.emissions.get(doc.audioAssetId ?? '')
    if (!e) return undefined
    return {
      ...doc,
      source: mixed(doc),
      lines: realignFrom(e.em, e.vocab, doc.lines, lineIndex, wordIndex, time),
    }
  }

  /** Re-aligns one line between its neighbours, e.g. after its text was corrected. */
  realignLine(doc: LyricsDoc, lineIndex: number): LyricsDoc | undefined {
    const e = this.emissions.get(doc.audioAssetId ?? '')
    if (!e) return undefined
    return { ...doc, source: mixed(doc), lines: realignLine(e.em, e.vocab, doc.lines, lineIndex) }
  }

  /** The song's vocals at 16 kHz, from its stems or separated first; `rest` reports progress for what follows. */
  private async vocals(
    songId: Id,
    deps: LyricsDeps,
    ctx: JobContext,
    lyricsRate: number,
  ): Promise<{ vocals: DecodedAudio; vocalsId: Id; rest: JobContext }> {
    const project = deps.editor.getProject()
    const song = songAsset(project, songId)
    const stored = vocalsAsset(project, songId)
    if (stored) {
      ctx.progress({ stage: 'decode', message: 'Reading the vocals' })
      const vocals = await this.decode(await deps.store.getFile(stored), CTC_SAMPLE_RATE)
      return { vocals, vocalsId: stored.id, rest: ctx }
    }
    const separate = await separateRate()
    const split = separate / (separate + lyricsRate)
    ctx.progress({ stage: 'decode', fraction: 0, message: 'Reading the song' })
    const audio = await this.decode(await deps.store.getFile(song), DEMUCS_SAMPLE_RATE)
    const result = await this.stems.separateIn(audio, part(ctx, 0, split))
    // Stored before the lyrics step, so the stems are kept even if it fails or is cancelled.
    deps.editor.dispatch(await stemEdits(result, song, deps.store), { history: 'skip' })
    const stem = result.stems.find((s) => s.name === 'vocals')
    const vocalsId = deps.editor.getProject().analysis.audio[songId]?.stems?.vocals
    if (!stem || !vocalsId) throw new JobError('internal', 'Stem separation returned no vocals')
    ctx.progress({ stage: 'decode', fraction: split, message: 'Reading the vocals' })
    const vocals = await this.decode(
      new Blob([stem.audio.data], { type: stem.audio.mimeType }),
      CTC_SAMPLE_RATE,
    )
    return { vocals, vocalsId, rest: part(ctx, split, 1) }
  }

  private async call<T>(run: (client: WorkerClient<LyricsWorkerApi>) => Promise<T>): Promise<T> {
    const client = createWorkerClient<LyricsWorkerApi>(this.createWorker())
    try {
      return await run(client)
    } finally {
      client.terminate()
    }
  }
}

function chorusFor(deps: LyricsDeps, songId: Id, doc: LyricsDoc): EditCommand | null {
  const analysis = deps.editor.getProject().analysis.audio[songId]
  return analysis ? lyricChorusCommand(analysis, doc) : null
}

function songAsset(project: Project, songId: Id): Asset {
  const song = project.assets[songId]
  if (!song) throw new JobError('invalid-input', 'The song is no longer in the project')
  return song
}

function vocalsAsset(project: Project, songId: Id): Asset | undefined {
  const id = project.analysis.audio[songId]?.stems?.vocals
  return id === undefined ? undefined : project.assets[id]
}

const lyricsRate = (kind: LyricsRequest['kind']) =>
  kind === 'time' ? SECONDS_PER_SECOND.align : SECONDS_PER_SECOND.transcribe + SECONDS_PER_SECOND.align

async function separateRate(): Promise<number> {
  return SECONDS_PER_SECOND.separate[stemDevice(await detectCapabilities())]
}

function modelFiles(model: ModelDescriptor) {
  const files = Object.values(model.files)
  return {
    name: model.name,
    bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    urls: files.map((f) => f.url),
  }
}

const isCached = (url: string) => modelCache.has(url)

/** A view of `ctx` whose progress fractions map onto `from`..`to` of the whole job. */
function part(ctx: JobContext, from: number, to: number): JobContext {
  return {
    signal: ctx.signal,
    throwIfCancelled: () => ctx.throwIfCancelled(),
    progress: (p) =>
      ctx.progress(p.fraction === undefined ? p : { ...p, fraction: from + p.fraction * (to - from) }),
  }
}

const mixed = (doc: LyricsDoc): LyricsDoc['source'] => (doc.source === 'transcribed' ? 'mixed' : doc.source)

export function setLyricsCommand(lyrics: LyricsDoc | null): EditCommand {
  return { type: 'lyrics.set', lyrics }
}
