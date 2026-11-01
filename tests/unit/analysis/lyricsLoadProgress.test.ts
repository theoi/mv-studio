import { afterEach, describe, expect, it, vi } from 'vitest'
import { alignerLoadProgress, whisperLoadProgress } from '../../../src/analysis/lyrics/loadProgress.ts'
import { WAV2VEC2_MODEL, whisperFileUrls, type WhisperModelSpec } from '../../../src/analysis/models.ts'
import type { JobProgress } from '../../../src/shared/jobs.ts'
import { loadModelFiles } from '../../../src/shared/models.ts'
import { sharedFetch, withModelProgress } from '../../../src/shared/transformers.ts'

const spec: WhisperModelSpec = {
  id: 'whisper-test',
  name: 'Whisper test',
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/t/whisper',
  repo: 't/whisper',
  revision: 'r1',
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  bytes: 1_000_000,
}
const [encoder, decoder] = whisperFileUrls(spec) as [string, string]
const config = 'https://huggingface.co/t/whisper/resolve/r1/config.json'
const runtime = 'http://localhost/mv-studio/assets/ort-wasm-simd-threaded.asyncify.wasm'
/** Sizes of the files served, and whether the server sends their Content-Length (small JSON files come without). */
const files: Record<string, { bytes: number; length: boolean }> = {
  [config]: { bytes: 2_000, length: false },
  [encoder]: { bytes: 400_000, length: true },
  [decoder]: { bytes: 590_000, length: true },
  [runtime]: { bytes: 300_000, length: true },
}

/** Serves `files` in 5 kB chunks, one chunk per pull, so parallel downloads interleave as they do in a browser. */
function serve() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const file = files[url]
      if (!file) return new Response(null, { status: 404 })
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 0))
          const n = Math.min(5_000, file.bytes - sent)
          if (n === 0) return controller.close()
          sent += n
          controller.enqueue(new Uint8Array(n))
        },
      })
      return new Response(body, { headers: file.length ? { 'content-length': String(file.bytes) } : {} })
    }),
  )
}

/** A model cache holding `urls`, in place of Cache Storage. */
function cache(urls: string[]) {
  const stored = new Map(urls.map((u) => [u, new ArrayBuffer(files[u]?.bytes ?? 0)]))
  const store = {
    match: async (url: string) => (stored.has(url) ? new Response(stored.get(url)) : undefined),
    put: async (url: string, res: Response) => void stored.set(url, await res.arrayBuffer()),
    delete: async (url: string) => stored.delete(url),
  }
  vi.stubGlobal('caches', { open: async () => store, delete: async () => true })
}

/** What Transformers.js 4 does when it loads Whisper: configs first, then both graphs in parallel and the runtime. */
async function loadWhisper(cached: boolean): Promise<JobProgress[]> {
  const reports: JobProgress[] = []
  await withModelProgress(
    whisperLoadProgress(spec, cached, (p) => reports.push(p)),
    async () => {
      await sharedFetch(config)
      await Promise.all([sharedFetch(encoder).then(() => sharedFetch(runtime)), sharedFetch(decoder)])
    },
  )
  return reports
}

afterEach(() => vi.unstubAllGlobals())

describe('Whisper load progress', () => {
  it('shows one download line for every file, then that the model is starting once both graphs are in', async () => {
    serve()
    cache([])
    const reports = await loadWhisper(false)
    const downloads = reports.filter((p) => p.stage === 'download')
    expect(new Set(downloads.map((p) => p.message))).toEqual(
      new Set(['Downloading the transcription model (1 MB, once)']),
    )
    const fractions = downloads.map((p) => p.fraction ?? NaN)
    expect(fractions[0]).toBe(0)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    // The graphs are 990 of the model's 1000 kB; the runtime and config files do not count.
    expect(fractions.at(-1)).toBeGreaterThan(0.97)
    expect(fractions.at(-1)).toBeLessThanOrEqual(0.99)
    expect(reports.at(-1)).toEqual({
      stage: 'load',
      fraction: 1,
      message: 'Starting the transcription model',
    })
    expect(reports.filter((p) => p.stage === 'load')).toHaveLength(1)
    // About one report per 1% instead of one per chunk (about 260 chunks here, tens of thousands in a browser).
    expect(reports.length).toBeLessThanOrEqual(102)
  })

  it('says only that the model is starting when its graphs are cached', async () => {
    serve()
    cache([config, encoder, decoder])
    expect(await loadWhisper(true)).toEqual([
      { stage: 'load', fraction: 1, message: 'Starting the transcription model' },
    ])
  })
})

describe('aligner load progress', () => {
  it('reports the download in steps of about 1%, and nothing when the files are cached', async () => {
    const model = { ...WAV2VEC2_MODEL, files: { model: { url: decoder, bytes: 590_000 } } }
    serve()
    cache([])
    const reports: JobProgress[] = []
    await loadModelFiles(model, { onProgress: alignerLoadProgress((p) => reports.push(p)) })
    expect(new Set(reports.map((p) => p.message))).toEqual(
      new Set(['Downloading the lyrics aligner (95 MB, once)']),
    )
    expect(reports.length).toBeGreaterThan(10)
    expect(reports.length).toBeLessThanOrEqual(101)
    expect(reports.at(-1)?.fraction).toBe(1)

    const again: JobProgress[] = []
    await loadModelFiles(model, { onProgress: alignerLoadProgress((p) => again.push(p)) })
    expect(again).toEqual([])
  })
})
