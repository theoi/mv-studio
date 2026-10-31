import type { LyricLine, LyricWord } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import type { ModelDevice } from '../../shared/models.ts'
import { transfer, type WorkerCallContext } from '../../shared/worker.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { mixToMono, resample } from '../dsp/resample.ts'
import type { WhisperSize } from '../models.ts'
import { alignLines, type CtcVocabulary } from './align.ts'
import type { CtcEmissions } from './ctc.ts'
import { planChunks, voiceActivity, type TimeRange } from './vad.ts'
import { CTC_SAMPLE_RATE, ctcEmissions, type CtcModel } from './wav2vec2.ts'
import { alignTranscript, detectLanguage, transcribeChunks, type Transcriber } from './whisper.ts'

export interface LyricsWorkerDeps {
  ctcModel(ctx: WorkerCallContext): Promise<{ model: CtcModel; vocab: CtcVocabulary }>
  transcriber(
    size: WhisperSize,
    ctx: WorkerCallContext,
  ): Promise<{ transcriber: Transcriber; device: ModelDevice; dispose?: () => Promise<unknown> }>
}

export interface AlignTextArgs {
  /** The song's vocals stem. Any sample rate; 16 kHz mono avoids resampling. */
  vocals: DecodedAudio
  lines: { id?: string; text: string }[]
  /** Emissions from an earlier call for the same audio; skips the model. */
  emissions?: CtcEmissions
}

export interface TranscribeArgs {
  /** The song's vocals stem: transcribed, and used to find where someone sings. */
  vocals: DecodedAudio
  language?: string
  size: WhisperSize
}

export interface TranscribeResult {
  words: LyricWord[]
  segmentStarts: number[]
  language: string
  /** Detection confidence (0..1), or undefined when the language was given. */
  languageProbability?: number
  device: ModelDevice
  emissions: CtcEmissions
  vocab: CtcVocabulary
  /** Where someone sings in the vocals (`voiceActivity`), kept with the emissions for re-aligning. */
  voiced: TimeRange[]
}

function mono16k(audio: DecodedAudio): Float32Array {
  const mono = audio.channels.length === 1 ? (audio.channels[0] as Float32Array) : mixToMono(audio.channels)
  return audio.sampleRate === CTC_SAMPLE_RATE ? mono : resample(mono, audio.sampleRate, CTC_SAMPLE_RATE)
}

/** Worker methods for lyrics. Kept free of worker globals so tests can drive them over a MessageChannel. */
export function createLyricsApi(deps: LyricsWorkerDeps) {
  async function emissionsFor(pcm: Float32Array, ctx: WorkerCallContext, from: number, to: number) {
    const { model, vocab } = await deps.ctcModel({
      signal: ctx.signal,
      progress: (p) => ctx.progress({ ...p, fraction: from + (p.fraction ?? 0) * 0.1 * (to - from) }),
    })
    const message = 'Listening for each word'
    ctx.progress({ stage: 'align', fraction: from + 0.1 * (to - from), message })
    const em = await ctcEmissions(model, pcm, {
      signal: ctx.signal,
      onProgress: (f) =>
        ctx.progress({ stage: 'align', fraction: from + (0.1 + 0.9 * f) * (to - from), message }),
    })
    return { em, vocab }
  }

  return {
    async align(args: AlignTextArgs, ctx: WorkerCallContext) {
      if (!args.vocals.channels[0]?.length) throw new JobError('invalid-input', 'The song has no audio')
      const pcm = mono16k(args.vocals)
      const { em, vocab } = args.emissions
        ? { em: args.emissions, vocab: (await deps.ctcModel(ctx)).vocab }
        : await emissionsFor(pcm, ctx, 0, 0.95)
      const voiced = voiceActivity(pcm, CTC_SAMPLE_RATE)
      const lines: LyricLine[] = alignLines(em, vocab, args.lines, { voiced })
      return transfer({ lines, emissions: em, vocab, voiced }, [em.logProbs.buffer])
    },

    /**
     * The aligner's per-frame output for the vocals and where someone sings in them, so words can be re-aligned later
     * without the model.
     */
    async emissions(args: { vocals: DecodedAudio }, ctx: WorkerCallContext) {
      if (!args.vocals.channels[0]?.length) throw new JobError('invalid-input', 'The song has no audio')
      const pcm = mono16k(args.vocals)
      const { em, vocab } = await emissionsFor(pcm, ctx, 0, 1)
      const voiced = voiceActivity(pcm, CTC_SAMPLE_RATE)
      return transfer({ emissions: em, vocab, voiced }, [em.logProbs.buffer])
    },

    async transcribe(args: TranscribeArgs, ctx: WorkerCallContext) {
      if (!args.vocals.channels[0]?.length) throw new JobError('invalid-input', 'The song has no audio')
      const pcm = mono16k(args.vocals)
      const regions = voiceActivity(pcm, CTC_SAMPLE_RATE)
      if (regions.length === 0) throw new JobError('invalid-input', 'No singing found in the vocals stem')
      const chunks = planChunks(regions)
      const { transcriber, device, dispose } = await deps.transcriber(args.size, {
        signal: ctx.signal,
        progress: (p) => ctx.progress({ ...p, fraction: (p.fraction ?? 0) * 0.15 }),
      })
      let language = args.language
      let languageProbability: number | undefined
      if (!language) {
        ctx.progress({ stage: 'transcribe', fraction: 0.15, message: 'Detecting the language' })
        ;({ language, probability: languageProbability } = await detectLanguage(transcriber, pcm, chunks))
      }
      const message = 'Writing down the lyrics'
      ctx.progress({ stage: 'transcribe', fraction: 0.18, message })
      const segments = await transcribeChunks(transcriber, pcm, chunks, {
        language,
        signal: ctx.signal,
        onProgress: (f) => ctx.progress({ stage: 'transcribe', fraction: 0.18 + 0.52 * f, message }),
      })
      await dispose?.()
      const { em, vocab } = await emissionsFor(pcm, ctx, 0.7, 1)
      const { words, segmentStarts } = alignTranscript(em, vocab, segments, chunks)
      const result: TranscribeResult = {
        words,
        segmentStarts,
        language,
        languageProbability,
        device,
        emissions: em,
        vocab,
        voiced: regions,
      }
      return transfer(result, [em.logProbs.buffer])
    },
  }
}

export type LyricsWorkerApi = ReturnType<typeof createLyricsApi>
