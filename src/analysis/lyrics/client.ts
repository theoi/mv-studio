import type { ProjectEditor } from '../../model/editor.ts'
import type { Asset, EditCommand, Id, LyricsDoc, Project } from '../../model/index.ts'
import { JobError, jobs, type JobContext, type JobHandle, type JobRunner } from '../../shared/jobs.ts'
import { modelCache, type ModelDescriptor } from '../../shared/models.ts'
import { createWorkerClient, runWorkerCall, type WorkerClient } from '../../shared/worker.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { decodeAudioFile } from '../decode.ts'
import { mixToMono } from '../dsp/resample.ts'
import { part } from '../jobContext.ts'
import { DEMUCS_MODEL, WAV2VEC2_MODEL, WHISPER_MODELS, whisperFileUrls, type WhisperSize } from '../models.ts'
import { StemSeparationService, type StemStore } from '../stems/client.ts'
import { lyricChorusCommand } from '../structure/chorus.ts'
import { realignFrom, realignLine, type CtcVocabulary } from './align.ts'
import type { CtcEmissions } from './ctc.ts'
import type { TimeRange } from './vad.ts'
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
   * Pasted lyrics: relabels the song's sections so the lyrics' repeated lines are the chorus. Drafts: raises the
   * confidence of the detected chorus when the draft repeats there too (see `lyricChorusCommand`). Null when there is
   * nothing to change. Dispatch it with `{ history: 'skip' }` together with the lyrics.
   */
  chorus: EditCommand | null
  /** Pasted lyrics: where the aligner heard singing they do not list and kept the lines out of (seconds). */
  unlisted?: TimeRange[]
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
  store: StemStore
}

export interface LyricsServiceOptions {
  runner?: JobRunner
  createWorker?: () => Worker
  stems?: StemSeparationService
  /** Decodes audio files; defaults to the browser's decoder (main thread only). */
  decode?: (file: Blob, sampleRate: number) => Promise<DecodedAudio>
}

/**
 * Processing seconds per second of song on WASM threads (4 cores), rounded up from held-out runs: timing took 1.20 to
 * 1.25 times the earlier 0.25 s per second; drafts took 142 to 148 s for 3.3 to 4.2 minute songs, since Whisper only
 * hears the sung passages.
 */
const SECONDS_PER_SECOND = { align: 0.32, transcribe: 0.42 }
/** Reading the vocals and starting the cached models. */
const SETUP_SECONDS = 5
const DRAFT_SIZE: WhisperSize = 'small'

interface Emissions {
  em: CtcEmissions
  vocab: CtcVocabulary
  /** Where someone sings, so re-aligned words stay out of instrumental stretches as the first alignment did. */
  voiced: readonly TimeRange[]
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
    this.decode = options.decode ?? decodeAudioFile
    this.stems = options.stems ?? new StemSeparationService({ runner: this.runner, decode: this.decode })
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
    const duration = song.duration ?? 0
    const separate = separatesStems ? await this.stems.jobSeconds(duration) : 0
    const slowdown = await this.stems.slowdown()
    return {
      separatesStems,
      downloads,
      downloadBytes: downloads.reduce((sum, d) => sum + d.bytes, 0),
      seconds: separate + lyricsSeconds(duration, request.kind, slowdown),
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
        const duration = deps.editor.getProject().assets[songId]?.duration ?? 0
        const { vocals, mix, vocalsId, rest } = await this.vocals(
          songId,
          deps,
          ctx,
          lyricsRate(request.kind),
          lyricsSeconds(duration, request.kind, await this.stems.slowdown()),
        )
        if (request.kind === 'time') {
          const cached = this.emissions.get(songId)
          const emissions = cached?.vocalsId === vocalsId ? cached.em : undefined
          const result = await this.call((c) =>
            runWorkerCall(c, 'align', { vocals, mix, lines, emissions }, rest, buffers(vocals, mix)),
          )
          this.emissions.set(songId, {
            em: result.emissions,
            vocab: result.vocab,
            voiced: result.voiced,
            vocalsId,
          })
          const doc: LyricsDoc = { audioAssetId: songId, source: 'pasted', lines: result.lines }
          return { doc, chorus: chorusFor(deps, songId, doc), unlisted: result.unlisted }
        }
        const size = request.size ?? DRAFT_SIZE
        const result = await this.call((c) =>
          runWorkerCall(
            c,
            'transcribe',
            { vocals, mix, language: request.language, size },
            rest,
            buffers(vocals, mix),
          ),
        )
        this.emissions.set(songId, {
          em: result.emissions,
          vocab: result.vocab,
          voiced: result.voiced,
          vocalsId,
        })
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

  /**
   * Listens to the song's vocals so `realignFrom` and `realignLine` work, e.g. after the project was reloaded: job
   * `analysis.realign` (its own kind, so it never shows as a lyrics run), separating stems first when the song has
   * none. Does nothing when they already work.
   */
  prepareRealign(songId: Id, deps: LyricsDeps): JobHandle<void> {
    return this.runner.run({
      kind: 'analysis.realign',
      title: 'Listening to the vocals',
      run: async (ctx) => {
        const current = vocalsAsset(deps.editor.getProject(), songId)
        if (current && this.emissions.get(songId)?.vocalsId === current.id) return
        const duration = deps.editor.getProject().assets[songId]?.duration ?? 0
        const { vocals, mix, vocalsId, rest } = await this.vocals(
          songId,
          deps,
          ctx,
          SECONDS_PER_SECOND.align,
          lyricsSeconds(duration, 'time', await this.stems.slowdown()),
        )
        const result = await this.call((c) =>
          runWorkerCall(c, 'emissions', { vocals, mix }, rest, buffers(vocals, mix)),
        )
        this.emissions.set(songId, {
          em: result.emissions,
          vocab: result.vocab,
          voiced: result.voiced,
          vocalsId,
        })
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
      lines: realignFrom(e.em, e.vocab, doc.lines, lineIndex, wordIndex, time, { voiced: e.voiced }),
    }
  }

  /** Re-aligns one line between its neighbours, e.g. after its text was corrected. */
  realignLine(doc: LyricsDoc, lineIndex: number): LyricsDoc | undefined {
    const e = this.emissions.get(doc.audioAssetId ?? '')
    if (!e) return undefined
    return {
      ...doc,
      source: mixed(doc),
      lines: realignLine(e.em, e.vocab, doc.lines, lineIndex, { voiced: e.voiced }),
    }
  }

  /**
   * The song's vocals and the song itself at 16 kHz mono, the vocals from its stems or separated first; `rest`
   * reports progress for what follows.
   */
  private async vocals(
    songId: Id,
    deps: LyricsDeps,
    ctx: JobContext,
    lyricsRate: number,
    lyricsSeconds: number,
  ): Promise<{ vocals: DecodedAudio; mix: DecodedAudio; vocalsId: Id; rest: JobContext }> {
    const project = deps.editor.getProject()
    const song = songAsset(project, songId)
    const read = async (file: Blob) => mono(await this.decode(file, CTC_SAMPLE_RATE))
    const readMix = async () => read(await deps.store.getFile(song))
    const stored = vocalsAsset(project, songId)
    if (stored) {
      ctx.progress({ stage: 'decode', message: 'Reading the vocals' })
      const vocals = await read(await deps.store.getFile(stored))
      return { vocals, mix: await readMix(), vocalsId: stored.id, rest: ctx }
    }
    const separate = await this.stems.rate()
    const split = separate / (separate + lyricsRate)
    // Stored before the lyrics step, so the stems are kept even if it fails or is cancelled.
    const result = await this.stems.separateSongIn(songId, deps, part(ctx, 0, split, lyricsSeconds))
    const stem = result.stems.find((s) => s.name === 'vocals')
    const vocalsId = deps.editor.getProject().analysis.audio[songId]?.stems?.vocals
    if (!stem || !vocalsId) throw new JobError('internal', 'Stem separation returned no vocals')
    ctx.progress({ stage: 'decode', fraction: split, message: 'Reading the vocals' })
    const vocals = await read(new Blob([stem.audio.data], { type: stem.audio.mimeType }))
    return { vocals, mix: await readMix(), vocalsId, rest: part(ctx, split, 1) }
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

const mono = (audio: DecodedAudio): DecodedAudio =>
  audio.channels.length === 1
    ? audio
    : { sampleRate: audio.sampleRate, channels: [mixToMono(audio.channels)] }

/** Moved to the worker rather than copied: a long song and its vocals take tens of MB each, and neither is used after. */
const buffers = (...audio: DecodedAudio[]) => audio.flatMap((a) => a.channels.map((c) => c.buffer))

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

/**
 * Seconds timing or drafting the lyrics of a song of `duration` seconds takes once its vocals are separated.
 * `slowdown` is how much longer than the defaults this device's stem separation took; the lyrics models run on the
 * same WASM threads, so they scale with it.
 */
export function lyricsSeconds(duration: number, kind: LyricsRequest['kind'], slowdown = 1): number {
  return Math.ceil(SETUP_SECONDS + duration * lyricsRate(kind) * slowdown)
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

const mixed = (doc: LyricsDoc): LyricsDoc['source'] => (doc.source === 'transcribed' ? 'mixed' : doc.source)

export function setLyricsCommand(lyrics: LyricsDoc | null): EditCommand {
  return { type: 'lyrics.set', lyrics }
}
