import { describe, expect, it } from 'vitest'
import type { JobContext, JobProgress } from '../../../../src/shared/jobs.ts'
import type { ModelFileProgress } from '../../../../src/shared/transformers.ts'
import {
  downloadLines,
  modelDownloads,
  withDownloadLines,
  type ModelDownload,
} from '../../../../src/vision/runtime/downloads.ts'

const DEPTH_LINE = 'Downloading the depth estimator (27 MB, once)'
const DEPTH_WEIGHTS = 27_258_801

function file(name: string, loaded: number, total: number, cached = false): ModelFileProgress {
  return {
    stage: cached ? 'cached' : 'download',
    file: name,
    cached,
    bytesLoaded: loaded,
    bytesTotal: total,
    fraction: loaded / total,
  }
}

describe('modelDownloads', () => {
  it('reports the weights downloading as the model’s line, about every 1%, and done once they are in', () => {
    const reports: ModelDownload[] = []
    const d = modelDownloads('depth', (p) => reports.push(p as ModelDownload))
    d.file(file('config.json', 38, 38))
    for (let loaded = 0; loaded < DEPTH_WEIGHTS; loaded += 65_536)
      d.file(file('model_quantized.onnx', loaded, DEPTH_WEIGHTS))
    d.file(file('model_quantized.onnx', DEPTH_WEIGHTS, DEPTH_WEIGHTS))
    d.end()

    expect(new Set(reports.map((r) => r.message))).toEqual(new Set([DEPTH_LINE]))
    expect(reports[0]).toMatchObject({ stage: 'download', model: 'depth', fraction: 0 })
    expect(reports.at(-1)).toEqual({
      stage: 'download',
      model: 'depth',
      message: DEPTH_LINE,
      fraction: 1,
      done: true,
    })
    expect(reports.filter((r) => r.done)).toHaveLength(1)
    // At most one report per 1% instead of one per chunk (416 chunks here).
    expect(reports.length).toBeGreaterThan(50)
    expect(reports.length).toBeLessThanOrEqual(101)
    const fractions = reports.map((r) => r.fraction)
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
  })

  it('says nothing for cached weights and for weights under 1 MB', () => {
    const reports: JobProgress[] = []
    const cutout = modelDownloads('cutout', (p) => reports.push(p))
    cutout.file(file('selfie_segmenter.tflite', 100_000, 249_537))
    cutout.file(file('efficientdet_lite0.tflite', 4_602_795, 4_602_795, true))
    cutout.end()
    expect(reports).toEqual([])
  })

  it('ends a download that stopped partway, so its line goes', () => {
    const reports: ModelDownload[] = []
    const d = modelDownloads('picker', (p) => reports.push(p as ModelDownload))
    d.file(file('magic_touch.tflite', 1_000_000, 6_227_884))
    d.end()
    expect(reports.map((r) => [r.message, r.done ?? false])).toEqual([
      ['Downloading the object picker (6 MB, once)', false],
      ['Downloading the object picker (6 MB, once)', true],
    ])
  })
})

/** A job context that keeps its progress as the job runtime does, and a vision service whose downloads the test sends. */
function harness() {
  let state: JobProgress = {}
  let listener: ((d: ModelDownload) => void) | undefined
  const ctx: JobContext = {
    signal: new AbortController().signal,
    progress: (p) => {
      state = { ...state, ...p }
    },
    throwIfCancelled: () => undefined,
  }
  const vision = {
    watchDownloads: (l: (d: ModelDownload) => void) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
  }
  const download = (fraction: number, done = false): ModelDownload => ({
    stage: 'download',
    model: 'depth',
    message: DEPTH_LINE,
    fraction,
    ...(done ? { done: true as const } : {}),
  })
  return {
    ctx,
    vision,
    send: (d: ModelDownload) => listener?.(d),
    download,
    state: () => state,
    watching: () => listener !== undefined,
  }
}

describe('downloadLines', () => {
  it('shows a model’s download in place of the job’s line, then the job’s line and progress again', () => {
    const h = harness()
    const lines = downloadLines(h.ctx, h.vision, ['depth'])
    lines.progress({ fraction: 0.02, stage: 'loading', message: 'Estimating depth · beach.jpg' })
    h.send(h.download(0.4))
    expect(h.state()).toEqual({ stage: 'download', fraction: 0.4, message: DEPTH_LINE })
    // What the job reports meanwhile waits for the download to end.
    lines.progress({ fraction: 0.1, stage: 'estimating-depth' })
    expect(h.state()).toEqual({ stage: 'download', fraction: 0.4, message: DEPTH_LINE })
    h.send(h.download(1, true))
    expect(h.state()).toEqual({
      stage: 'estimating-depth',
      fraction: 0.1,
      message: 'Estimating depth · beach.jpg',
    })
  })

  it('leaves out the downloads of models the job does not use', () => {
    const h = harness()
    const lines = downloadLines(h.ctx, h.vision, ['cutout'])
    lines.progress({ fraction: 0.5, message: 'Looking for people · clip.mp4' })
    h.send(h.download(0.4))
    h.send(h.download(1, true))
    expect(h.state()).toEqual({ fraction: 0.5, message: 'Looking for people · clip.mp4' })
  })
})

describe('withDownloadLines', () => {
  it('stops watching downloads when the job ends, also when it fails', async () => {
    const h = harness()
    let watchingInRun = false
    await withDownloadLines(h.vision, ['depth'], async (ctx) => {
      watchingInRun = h.watching()
      h.send(h.download(0.3))
      ctx.progress({ fraction: 0.6, message: 'Estimating depth · beach.jpg' })
    })(h.ctx)
    expect(watchingInRun).toBe(true)
    expect(h.watching()).toBe(false)
    expect(h.state()).toEqual({ stage: 'download', fraction: 0.3, message: DEPTH_LINE })

    const failed = withDownloadLines(h.vision, ['depth'], async () => {
      throw new Error('no')
    })(h.ctx)
    await expect(failed).rejects.toThrow('no')
    expect(h.watching()).toBe(false)
  })
})
