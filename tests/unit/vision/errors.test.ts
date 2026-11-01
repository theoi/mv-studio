import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobError } from '../../../src/shared/jobs.ts'
import { registerModelFiles, sharedFetch } from '../../../src/shared/transformers.ts'
import { downloadFailed, startFailed } from '../../../src/vision/errors.ts'
import { mediapipeModel } from '../../../src/vision/runtime/loaders.ts'
import { loadingModel } from '../../../src/vision/runtime/loading.ts'
import { VISION_MODELS, type VisionModel } from '../../../src/vision/runtime/models.ts'

const URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b736/onnx/model.onnx'

describe('model errors', () => {
  it('name the model as the app does instead of the file’s URL, say what to do, and keep the code', () => {
    const offline = downloadFailed('depth', new JobError('network', `Couldn’t download model file ${URL}`))
    expect(offline).toMatchObject({
      code: 'network',
      retryable: true,
      message: 'Couldn’t download the depth estimator. Check your connection and try again.',
      details: `Couldn’t download model file ${URL}`,
    })
    // MediaPipe's runtime that fails to load.
    const runtime = downloadFailed('cutout', new TypeError('Failed to fetch dynamically imported module'))
    expect(runtime).toMatchObject({
      code: 'model-load',
      message: 'Couldn’t download the person finder. Check your connection and try again.',
    })
    const session = startFailed('matte', new Error('failed to create session'))
    expect(session).toMatchObject({ code: 'model-load', message: 'Couldn’t start the edge refiner' })
  })

  it('pass on a loader error that names the model already, and name the model in one that names another', () => {
    const refused = () =>
      new JobError(
        'model-load',
        'Couldn’t download the depth estimator. The server refused to send the file. If your network blocks huggingface.co, try another network.',
        { details: { url: URL, status: 403 } },
      )
    const depth = refused()
    expect(downloadFailed('depth', depth)).toBe(depth)
    expect(startFailed('depth', depth)).toBe(depth)
    const other = refused()
    expect(downloadFailed('tagger', other)).toMatchObject({
      code: 'model-load',
      message: 'Couldn’t download the footage tagger. Check your connection and try again.',
      details: other.message,
    })
  })

  it('pass other failures on as they are, and name a model once', () => {
    expect(startFailed('depth', new Error('std::bad_alloc'))).toMatchObject({
      code: 'out-of-memory',
      message: 'std::bad_alloc',
    })
    const cancelled = new JobError('cancelled', 'Cancelled')
    expect(downloadFailed('picker', cancelled)).toBe(cancelled)
    const named = downloadFailed('picker', new JobError('network', `Couldn’t download model file ${URL}`))
    expect(startFailed('picker', named)).toBe(named)
  })
})

describe('a vision model’s download that fails', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Loads `model` as the workers do: the loader's errors go through `downloadFailed`. */
  const failure = (model: VisionModel, run: () => Promise<unknown>) =>
    loadingModel(model, undefined, () =>
      run().catch((e: unknown) => {
        throw downloadFailed(model, e)
      }),
    ).catch((e: unknown) => e)

  const depth = VISION_MODELS.depthAnythingSmall.files.model

  it('says it isn’t arriving, naming the model', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const error = failure('depth', () => sharedFetch(depth.url))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await error).toMatchObject({
      code: 'network',
      retryable: true,
      message: 'The download of the depth estimator isn’t arriving. Check your connection and try again.',
      details: { url: depth.url, seconds: 30 },
    })
  })

  it.each([
    [401, 'The server didn’t send the file. Reload the page to get the latest MV Studio, then try again.'],
    [403, 'The server refused to send the file. If your network blocks huggingface.co, try another network.'],
    [404, 'The server didn’t send the file. Reload the page to get the latest MV Studio, then try again.'],
  ])('says why the server answered %i, naming the model', async (status, hint) => {
    registerModelFiles([depth])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status })),
    )
    expect(await failure('depth', () => sharedFetch(depth.url))).toMatchObject({
      code: 'model-load',
      retryable: false,
      message: `Couldn’t download the depth estimator. ${hint}`,
      details: { url: depth.url, status },
    })
  })

  it('names the host that refused a MediaPipe model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    )
    expect(await failure('cutout', () => mediapipeModel(VISION_MODELS.selfie, 'cutout'))).toMatchObject({
      code: 'model-load',
      message:
        'Couldn’t download the person finder. The server refused to send the file. If your network blocks storage.googleapis.com, try another network.',
      details: { url: VISION_MODELS.selfie.files.model.url, status: 403 },
    })
  })
})
