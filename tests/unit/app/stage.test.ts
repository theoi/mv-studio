import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdatingCue, previewShown } from '../../../src/app/screens/editor/stage.ts'

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

describe('the stage saying a paused frame is on its way', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A cue and what it shows. */
  function cue() {
    let shown = false
    const c = createUpdatingCue((next) => (shown = next))
    return { update: c.update, shown: () => shown }
  }

  it('says so once a pending still has waited 150 ms, and not for one that comes sooner', async () => {
    vi.useFakeTimers()
    const c = cue()
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(149)
    c.update(false, false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.shown()).toBe(false)
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(149)
    expect(c.shown()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.shown()).toBe(true)
  })

  it('stays up at least 300 ms, so a frame that comes just after doesn’t make it flicker, then goes with the frame', async () => {
    vi.useFakeTimers()
    const c = cue()
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(150 + 50)
    c.update(false, false)
    await vi.advanceTimersByTimeAsync(249)
    expect(c.shown()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.shown()).toBe(false)
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(150 + 2000)
    c.update(false, false)
    expect(c.shown()).toBe(false)
  })

  it('hides at once while a pointer is down (a drag), and comes back 150 ms after release while still pending', async () => {
    vi.useFakeTimers()
    const c = cue()
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(150)
    c.update(true, true)
    expect(c.shown()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.shown()).toBe(false)
    c.update(true, false)
    await vi.advanceTimersByTimeAsync(149)
    expect(c.shown()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(c.shown()).toBe(true)
  })
})
