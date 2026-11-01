import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKED_REQUEST_MARK,
  blockTelemetry,
  withoutTelemetry,
} from '../../../../src/vision/runtime/telemetry.ts'

const LOG = 'https://odml.pa.googleapis.com/v1/log'

const innerFetch = () => vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }))

const marks = () =>
  performance.getEntriesByName(BLOCKED_REQUEST_MARK).map((m) => (m as PerformanceMark).detail as string)

afterEach(() => performance.clearMarks(BLOCKED_REQUEST_MARK))

describe('withoutTelemetry', () => {
  it("answers MediaPipe's usage log itself, with a status its logger takes as a failed send", async () => {
    const inner = innerFetch()
    const guarded = withoutTelemetry(inner)
    const init = {
      method: 'POST',
      body: new Uint8Array(38),
      headers: { 'Content-Type': 'application/x-protobuf' },
    }
    const responses = [await guarded(LOG, init), await guarded(new Request(LOG, init))]
    expect(inner).not.toHaveBeenCalled()
    expect(responses.map((r) => r.status)).toEqual([403, 403])
    expect(marks()).toEqual([LOG, LOG])
  })

  it("blocks Google's other private API hosts too, and marks them without the query", async () => {
    const inner = innerFetch()
    const guarded = withoutTelemetry(inner)
    await guarded(new URL('https://firebaselogging-pa.googleapis.com/v1/log?key=secret'))
    await guarded('https://play.pa.googleapis.com/log')
    expect(inner).not.toHaveBeenCalled()
    expect(marks()).toEqual([
      'https://firebaselogging-pa.googleapis.com/v1/log',
      'https://play.pa.googleapis.com/log',
    ])
  })

  it('passes model downloads and every other request through unchanged', async () => {
    const inner = innerFetch()
    const guarded = withoutTelemetry(inner)
    const urls = [
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/vision_wasm_module_internal.wasm',
      'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
      'https://odml.pa.googleapis.com.example.test/v1/log',
      'https://example.test/?next=https://odml.pa.googleapis.com/v1/log',
      'not a url',
    ]
    for (const url of urls) {
      const init = { method: 'GET' }
      expect((await guarded(url, init)).status).toBe(200)
      expect(inner).toHaveBeenLastCalledWith(url, init)
    }
    expect(inner).toHaveBeenCalledTimes(urls.length)
    expect(marks()).toEqual([])
  })
})

describe('blockTelemetry', () => {
  it("guards the context's fetch once, however many tasks it creates", async () => {
    const inner = innerFetch()
    const scope = { fetch: inner }
    blockTelemetry(scope)
    const first = scope.fetch
    blockTelemetry(scope)
    expect(scope.fetch).toBe(first)
    await scope.fetch(LOG, { method: 'POST' })
    expect(inner).not.toHaveBeenCalled()
    await scope.fetch(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/vision_wasm_module_internal.js',
    )
    expect(inner).toHaveBeenCalledTimes(1)
  })
})
