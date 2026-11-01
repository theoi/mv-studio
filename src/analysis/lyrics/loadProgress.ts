import type { JobProgress } from '../../shared/jobs.ts'
import { downloadingModel, modelBytes, theModel } from '../../shared/models.ts'
import type { ModelFileProgress } from '../../shared/transformers.ts'
import { MODEL_TITLES, WAV2VEC2_MODEL, whisperFileUrls, type WhisperModelSpec } from '../models.ts'

/**
 * How far the fraction moves before a download reports again. A model streams in thousands of chunks, and a progress
 * message for each piled up on the main thread faster than it re-rendered, so the line showed one from seconds ago.
 */
const STEP = 0.01

/** Passes on reports that change the progress line: a new message, or a fraction at least `STEP` further or done. */
function throttled(report: (p: JobProgress) => void): (p: JobProgress) => void {
  let last: JobProgress | undefined
  return (p) => {
    const was = last?.fraction ?? 0
    const now = p.fraction ?? 0
    const same = last?.message === p.message && last?.stage === p.stage
    if (same && Math.abs(now - was) < STEP && !(now === 1 && was !== 1)) return
    last = p
    report(p)
  }
}

/**
 * One progress line for loading a Whisper model. Transformers.js fetches the config and tokenizer files, both graphs
 * in parallel and the ONNX Runtime binary, each with progress of its own, and then takes seconds to start the graphs
 * without any. So the line counts the graphs' bytes (nearly all of `spec.bytes`) and says the model is starting once
 * both are in. `cached`: both graphs were in the model cache before loading.
 */
export function whisperLoadProgress(
  spec: WhisperModelSpec,
  cached: boolean,
  report: (p: JobProgress) => void,
): (p: ModelFileProgress) => void {
  const send = throttled(report)
  const graphs = whisperFileUrls(spec).map((url) => url.slice(url.lastIndexOf('/') + 1))
  const message = downloadingModel(MODEL_TITLES.transcriber, spec.bytes)
  const loaded = new Map<string, number>()
  const done = new Set<string>()
  let fraction = 0
  let starting = false
  const start = () => {
    starting = true
    send({ stage: 'load', fraction: 1, message: `Starting ${theModel(MODEL_TITLES.transcriber)}` })
  }
  if (cached) start()
  else send({ stage: 'download', fraction: 0, message })
  return (p) => {
    if (starting || !graphs.includes(p.file)) return
    loaded.set(p.file, Math.max(loaded.get(p.file) ?? 0, p.cached ? 0 : (p.bytesLoaded ?? 0)))
    if (p.cached || p.fraction === 1) done.add(p.file)
    if (graphs.every((g) => done.has(g))) return start()
    const bytes = [...loaded.values()].reduce((a, b) => a + b, 0)
    fraction = Math.max(fraction, Math.min(1, bytes / spec.bytes))
    send({ stage: 'download', fraction, message, bytesLoaded: bytes, bytesTotal: spec.bytes })
  }
}

/** Progress of loading the lyrics aligner's files, for `loadModelFiles`: nothing for files read from the cache. */
export function alignerLoadProgress(report: (p: JobProgress) => void): (p: JobProgress) => void {
  const send = throttled(report)
  const message = downloadingModel(MODEL_TITLES.aligner, modelBytes(WAV2VEC2_MODEL))
  return (p) => {
    if (p.stage !== 'cached') send({ ...p, stage: 'download', message })
  }
}

/** Reported once the aligner's files are in, while its session starts (about a second). */
export const ALIGNER_STARTING: JobProgress = {
  stage: 'load',
  fraction: 1,
  message: `Starting ${theModel(MODEL_TITLES.aligner)}`,
}
