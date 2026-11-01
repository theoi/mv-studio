import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewShown } from '../../../src/app/screens/editor/stage.ts'

/** A preview whose current state shows when `show()` is called, or never; `fail()` stops it drawing. */
function fakePreview() {
  let show = () => {}
  let fail = (_error: Error) => {}
  const rendered = new Promise<void>((resolve, reject) => {
    show = resolve
    fail = reject
  })
  return { rendered: () => rendered, show: () => show(), fail: () => fail(new Error('The preview stopped')) }
}

/** Whether `promise` has resolved, once pending callbacks have run. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true))
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('thumbnails waiting for the preview to show a draft', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wait until the preview shows it', async () => {
    vi.useFakeTimers()
    const preview = fakePreview()
    const { shown } = previewShown(preview, 10_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await settled(shown)).toBe(false)
    preview.show()
    expect(await settled(shown)).toBe(true)
  })

  it('decode anyway once the time is up, when the preview never shows it', async () => {
    vi.useFakeTimers()
    const { shown } = previewShown(fakePreview(), 10_000)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(await settled(shown)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(shown)).toBe(true)
  })

  it('decode anyway once the preview can no longer draw', async () => {
    vi.useFakeTimers()
    const preview = fakePreview()
    const { shown } = previewShown(preview, 10_000)
    preview.fail()
    expect(await settled(shown)).toBe(true)
  })
})
