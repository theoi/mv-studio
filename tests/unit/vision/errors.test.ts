import { describe, expect, it } from 'vitest'
import { JobError } from '../../../src/shared/jobs.ts'
import { downloadFailed, startFailed } from '../../../src/vision/errors.ts'

const URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b736/onnx/model.onnx'

describe('model errors', () => {
  it('name the model as the app does instead of the file’s URL, and keep the code', () => {
    const offline = downloadFailed('depth', new JobError('network', `Couldn’t download model file ${URL}`))
    expect(offline).toMatchObject({
      code: 'network',
      retryable: true,
      message: 'Couldn’t download the depth estimator',
      details: `Couldn’t download model file ${URL}`,
    })
    const corrupt = downloadFailed('tagger', new JobError('model-load', `Checksum mismatch for ${URL}`))
    expect(corrupt).toMatchObject({ code: 'model-load', message: 'Couldn’t download the footage tagger' })
    const runtime = downloadFailed('cutout', new TypeError('Failed to fetch dynamically imported module'))
    expect(runtime).toMatchObject({ code: 'model-load', message: 'Couldn’t download the person finder' })
    const session = startFailed('matte', new Error('failed to create session'))
    expect(session).toMatchObject({ code: 'model-load', message: 'Couldn’t start the edge refiner' })
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
