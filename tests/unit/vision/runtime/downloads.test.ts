import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobError, type JobContext, type JobProgress } from '../../../../src/shared/jobs.ts'
import type { ModelFileProgress } from '../../../../src/shared/transformers.ts'
import {
  createWorkerClient,
  exposeWorker,
  type Endpoint,
  type WorkerCallContext,
} from '../../../../src/shared/worker.ts'
import {
  downloadLines,
  modelDownloads,
  routeDownloads,
  withDownloadLines,
  type ModelDownload,
} from '../../../../src/vision/runtime/downloads.ts'
import { VISION_MODELS } from '../../../../src/vision/runtime/models.ts'

const DEPTH_LINE = 'Downloading the depth estimator (27 MB, once)'
const TAGGER_LINE = 'Downloading the footage tagger (154 MB, once)'
const DEPTH_WEIGHTS = 27_258_801
const DEPTH_URL = VISION_MODELS.depthAnythingSmall.files.model.url

function file(url: string, loaded: number, total: number, cached = false): ModelFileProgress {
  return {
    stage: cached ? 'cached' : 'download',
    file: url.slice(url.lastIndexOf('/') + 1),
    url,
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
    d.file(file(DEPTH_URL.replace('onnx/model_quantized.onnx', 'config.json'), 38, 38))
    for (let loaded = 0; loaded < DEPTH_WEIGHTS; loaded += 65_536)
      d.file(file(DEPTH_URL, loaded, DEPTH_WEIGHTS))
    d.file(file(DEPTH_URL, DEPTH_WEIGHTS, DEPTH_WEIGHTS))
    d.end()

    expect(new Set(reports.map((r) => r.message))).toEqual(new Set([DEPTH_LINE]))
    expect(reports[0]).toMatchObject({ stage: 'download', model: 'depth', fraction: 0 })
    expect(reports.at(-1)).toEqual({
      stage: 'download',
      model: 'depth',
      message: DEPTH_LINE,
      fraction: 1,
      bytesLoaded: DEPTH_WEIGHTS,
      bytesTotal: DEPTH_WEIGHTS,
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
    cutout.file(file(VISION_MODELS.selfie.files.model.url, 100_000, 249_537))
    cutout.file(file(VISION_MODELS.personDetector.files.model.url, 4_602_795, 4_602_795, true))
    cutout.end()
    expect(reports).toEqual([])
  })

  it('leaves out the files of other models, which reach it when a worker’s calls overlap', () => {
    const reports: ModelDownload[] = []
    const depth = modelDownloads('depth', (p) => reports.push(p as ModelDownload))
    depth.file(file(VISION_MODELS.clipB32.files.vision.url, 30_000_000, 88_000_000))
    depth.file(file(VISION_MODELS.modnet.files.model.url, 3_000_000, 6_632_188))
    expect(reports).toEqual([])
    depth.file(file(DEPTH_URL.replace('model_quantized', 'model_fp16'), 0, 49_642_442))
    expect(reports.map((r) => [r.message, r.fraction])).toEqual([[DEPTH_LINE, 0]])
  })

  it('ends a download that stopped partway, so its line goes', () => {
    const reports: ModelDownload[] = []
    const d = modelDownloads('picker', (p) => reports.push(p as ModelDownload))
    d.file(file(VISION_MODELS.magicTouch.files.model.url, 1_000_000, 6_227_884))
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
  const fractions: number[] = []
  let listener: ((d: ModelDownload) => void) | undefined
  const ctx: JobContext = {
    signal: new AbortController().signal,
    progress: (p) => {
      state = { ...state, ...p }
      if (p.fraction !== undefined) fractions.push(p.fraction)
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
    bytesLoaded: Math.round(fraction * DEPTH_WEIGHTS),
    bytesTotal: DEPTH_WEIGHTS,
    ...(done ? { done: true as const } : {}),
  })
  return {
    ctx,
    vision,
    send: (d: ModelDownload) => listener?.(d),
    download,
    state: () => state,
    fractions: () => fractions,
    watching: () => listener !== undefined,
  }
}

describe('downloadLines', () => {
  it('shows a model’s download in place of the job’s line, then the job’s line again', () => {
    const h = harness()
    const lines = downloadLines(h.ctx, h.vision, ['depth'])
    lines.progress({ fraction: 0.02, stage: 'loading', message: 'Estimating depth · beach.jpg' })
    h.send(h.download(0.4))
    expect(h.state()).toMatchObject({ stage: 'download', message: DEPTH_LINE })
    // What the job reports meanwhile waits for the download to end.
    lines.progress({ fraction: 0.1, stage: 'estimating-depth' })
    expect(h.state()).toMatchObject({ stage: 'download', message: DEPTH_LINE })
    h.send(h.download(1, true))
    expect(h.state()).toMatchObject({ stage: 'estimating-depth', message: 'Estimating depth · beach.jpg' })
  })

  it('moves the bar on through a download and the job’s progress after it, never back', () => {
    const h = harness()
    const lines = downloadLines(h.ctx, h.vision, ['depth'])
    lines.progress({ fraction: 0.05, message: 'Estimating depth · beach.jpg' })
    for (const f of [0, 0.5, 0.99]) h.send(h.download(f))
    h.send(h.download(1, true))
    // The job's own progress restarts after its model loads.
    for (const f of [0.05, 0.3, 0.7]) lines.progress({ fraction: f })
    const shown = h.fractions()
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
    // The download fills half of what was left of the bar, and the job's progress the rest.
    expect(shown[3]).toBeCloseTo(0.05 + 0.95 * 0.5 * 0.99)
    lines.progress({ fraction: 1 })
    expect(h.state().fraction).toBe(1)
  })

  it('gives how far the download is in its bytes, apart from the bar, and tells `onLine` what it shows', () => {
    const h = harness()
    const heard: (string | null)[] = []
    const lines = downloadLines(
      h.ctx,
      { ...h.vision, onLine: (d) => heard.push(d && `${d.message} ${d.fraction}`) },
      ['depth'],
    )
    lines.progress({ fraction: 0.2, message: 'Estimating depth · beach.jpg' })
    h.send(h.download(0.4))
    expect(h.state()).toMatchObject({
      bytesLoaded: Math.round(0.4 * DEPTH_WEIGHTS),
      bytesTotal: DEPTH_WEIGHTS,
    })
    h.send(h.download(1, true))
    expect(h.state()).toMatchObject({ bytesLoaded: undefined, bytesTotal: undefined })
    expect(heard).toEqual([`${DEPTH_LINE} 0.4`, null])
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
    expect(h.state()).toMatchObject({ stage: 'download', message: DEPTH_LINE })

    const failed = withDownloadLines(h.vision, ['depth'], async () => {
      throw new Error('no')
    })(h.ctx)
    await expect(failed).rejects.toThrow('no')
    expect(h.watching()).toBe(false)
  })
})

describe('routeDownloads', () => {
  let channel: MessageChannel | undefined
  afterEach(() => {
    channel?.port1.close()
    channel?.port2.close()
  })

  it('ends the download of a call that was cancelled, so a job watching the model shows its own line again', async () => {
    const api = {
      embedImages(_args: undefined, ctx: WorkerCallContext) {
        const d = modelDownloads('tagger', ctx.progress)
        d.file(file(VISION_MODELS.clipB32.files.vision.url, 40_000_000, 88_000_000))
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => {
            // The worker's last report comes after the client has let go of the call.
            d.end()
            reject(new JobError('cancelled', 'Cancelled'))
          }),
        )
      },
    }
    channel = new MessageChannel()
    exposeWorker(api, channel.port1 as unknown as Endpoint)
    const client = createWorkerClient<typeof api>(channel.port2 as unknown as Endpoint)

    const h = harness()
    const dones: ModelDownload[] = []
    const autocut = downloadLines(h.ctx, h.vision, ['tagger'])
    autocut.progress({ fraction: 0.1, message: 'Waiting for footage analysis' })
    const controller = new AbortController()
    const call = routeDownloads(
      (onProgress) => client.call('embedImages', undefined, { signal: controller.signal, onProgress }),
      undefined,
      (d) => {
        if (d.done) dones.push(d)
        h.send(d)
      },
    )
    await vi.waitFor(() => expect(h.state().message).toBe(TAGGER_LINE))
    controller.abort()
    await expect(call).rejects.toMatchObject({ code: 'cancelled' })

    autocut.progress({ fraction: 0.5, message: 'Planning the cut' })
    expect(h.state().message).toBe('Planning the cut')
    expect(dones).toHaveLength(1)
  })
})
