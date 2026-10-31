import type { AudioFeatures, StemName } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import type { ModelDevice } from '../../shared/models.ts'
import { transfer, type WorkerCallContext } from '../../shared/worker.ts'
import { onsetStrength } from '../beats/onset.ts'
import type { DecodedAudio } from '../beats/fast.ts'
import { toAnalysisMono } from '../beats/fast.ts'
import { resample } from '../dsp/resample.ts'
import { computeAudioFeatures, featureReference } from '../features/features.ts'
import { ANALYSIS_SAMPLE_RATE, analyzeSpectrum } from '../frontend.ts'
import { DEMUCS_SAMPLE_RATE, DEMUCS_SOURCES, separateStems, type DemucsModel } from './demucs.ts'
import { createStemEncoder, pickStemCodec, type EncodedAudio, type StemCodec } from './encode.ts'

export interface StemsWorkerDeps {
  demucsModel(ctx: WorkerCallContext): Promise<{ model: DemucsModel; device: ModelDevice }>
  codec?: (sampleRate: number) => Promise<StemCodec>
}

export interface SeparatedStem {
  name: StemName
  audio: EncodedAudio
}

export interface StemSeparationResult {
  device: ModelDevice
  /** Wall-clock seconds spent separating (excluding the model download). */
  seconds: number
  stems: SeparatedStem[]
  stemFeatures: Partial<Record<StemName, AudioFeatures>>
}

/**
 * The error for a failure caused by running out of memory, or undefined. ONNX Runtime reports a failed WASM or GPU
 * allocation as a plain Error, not a RangeError.
 */
export function stemsOutOfMemory(error: unknown): JobError | undefined {
  if (error instanceof JobError) return error.code === 'out-of-memory' ? error : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (!/out of memory|\bOOM\b|alloc/i.test(message)) return undefined
  return new JobError('out-of-memory', 'This computer ran out of memory while separating stems.', {
    retryable: true,
    cause: error,
  })
}

/** Worker methods for stem separation. Kept free of worker globals so tests can drive them over a MessageChannel. */
export function createStemsApi(deps: StemsWorkerDeps) {
  return {
    async separate(args: { audio: DecodedAudio }, ctx: WorkerCallContext) {
      const { sampleRate } = args.audio
      if (!args.audio.channels[0]?.length) throw new JobError('invalid-input', 'The song has no audio')
      const channels =
        sampleRate === DEMUCS_SAMPLE_RATE
          ? args.audio.channels
          : args.audio.channels.map((c) => resample(c, sampleRate, DEMUCS_SAMPLE_RATE))
      const n = (channels[0] as Float32Array).length
      const { model, device } = await deps.demucsModel({
        signal: ctx.signal,
        progress: (p) => ctx.progress({ ...p, fraction: (p.fraction ?? 0) * 0.15 }),
      })
      const codec = await (deps.codec ?? pickStemCodec)(DEMUCS_SAMPLE_RATE)
      const encoders = await Promise.all(
        DEMUCS_SOURCES.map(() => createStemEncoder(codec, DEMUCS_SAMPLE_RATE)),
      )
      const monos = DEMUCS_SOURCES.map(() => new Float32Array(n))
      const message = `Separating vocals, drums, bass and other (${device === 'webgpu' ? 'GPU' : 'CPU'})`
      ctx.progress({ stage: 'separate', fraction: 0.15, message })
      const t0 = performance.now()
      try {
        await separateStems(
          model,
          channels,
          async (start, stems) => {
            for (const [s, [left, right]] of stems.entries()) {
              const mono = monos[s] as Float32Array
              const l = left as Float32Array
              const r = right as Float32Array
              for (let i = 0; i < l.length; i++) mono[start + i] = ((l[i] as number) + (r[i] as number)) / 2
              await encoders[s]?.add(start, l, r)
            }
          },
          {
            signal: ctx.signal,
            onProgress: (f) => ctx.progress({ stage: 'separate', fraction: 0.15 + 0.75 * f, message }),
          },
        )
      } catch (error) {
        throw stemsOutOfMemory(error) ?? error
      }
      const seconds = (performance.now() - t0) / 1000

      ctx.progress({ stage: 'features', fraction: 0.9, message: 'Measuring each stem' })
      const reference = featureReference(
        toAnalysisMono({ sampleRate: DEMUCS_SAMPLE_RATE, channels }),
        ANALYSIS_SAMPLE_RATE,
      )
      const stemFeatures: Partial<Record<StemName, AudioFeatures>> = {}
      for (const [s, name] of DEMUCS_SOURCES.entries()) {
        const mono = resample(monos[s] as Float32Array, DEMUCS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE)
        monos[s] = new Float32Array(0)
        const spec = analyzeSpectrum(mono, ANALYSIS_SAMPLE_RATE, ctx.signal)
        stemFeatures[name] = computeAudioFeatures(
          mono,
          ANALYSIS_SAMPLE_RATE,
          onsetStrength(spec),
          spec.fps,
          reference,
        )
      }
      ctx.progress({ stage: 'encode', fraction: 0.97, message: 'Saving stems' })
      const stems: SeparatedStem[] = []
      for (const [s, name] of DEMUCS_SOURCES.entries())
        stems.push({ name, audio: await (encoders[s] as (typeof encoders)[number]).finish() })
      const result: StemSeparationResult = { device, seconds, stems, stemFeatures }
      return transfer(
        result,
        stems.map((s) => s.audio.data),
      )
    },
  }
}

export type StemsWorkerApi = ReturnType<typeof createStemsApi>
