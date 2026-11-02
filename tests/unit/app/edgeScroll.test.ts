import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { edgeScroll } from '../../../src/app/screens/editor/timeline/edgeScroll.ts'

/** An 800 px wide timeline with no track headers that keeps whole pixels within its content, rounding as Chrome does. */
class Scroller {
  clientWidth = 800
  scrollWidth = 20000
  #left = 0
  get scrollLeft() {
    return this.#left
  }
  set scrollLeft(v: number) {
    this.#left = Math.min(this.scrollWidth - this.clientWidth, Math.max(0, Math.round(v)))
  }
  getBoundingClientRect() {
    return { left: 0 }
  }
}

describe('scrolling the timeline while a drag is held at its edge', () => {
  let frames: FrameRequestCallback[] = []
  const frame = (now: number) => {
    const due = frames
    frames = []
    for (const f of due) f(now)
  }
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** Starts a drag in the middle at `from` px, then holds the pointer at `x`; frames then run at the times given. */
  function hold(x: number, times: number[], from = 5000) {
    const el = new Scroller()
    el.scrollLeft = from
    let scrolls = 0
    const edge = edgeScroll(el as unknown as HTMLElement, 0, () => scrolls++)
    edge.follow(400)
    frame(500)
    edge.follow(x)
    for (const t of times) frame(t)
    return { el, moved: el.scrollLeft - from, scrolls }
  }
  /** A second of frames at `fps`, from 1 s on. */
  const second = (fps: number) => Array.from({ length: fps + 1 }, (_, i) => 1000 + (i * 1000) / fps)

  it('scrolls as far in a second at 5 frames a second as at 60 or 144', () => {
    // At the very edge, 1000 px a second; the first frame counts as a 60th of a second.
    for (const fps of [5, 30, 60, 144])
      expect(hold(800, second(fps)).moved, `${fps} fps`).toBeCloseTo(1017, -1)
  })

  it('keeps scrolling after a frame in which no time passed', () => {
    const times = [1000, 1016, 1016, ...second(60).map((t) => t + 100)]
    expect(hold(800, times).moved).toBeGreaterThan(1000)
  })

  it('scrolls slowly with the pointer just inside the zone, where a frame scrolls less than a pixel', () => {
    for (const fps of [60, 144]) {
      // 25 px a second, so each step that moves the timeline moves it one pixel.
      const { moved, scrolls } = hold(761, second(fps))
      expect(moved, `${fps} fps`).toBeGreaterThanOrEqual(24)
      expect(moved, `${fps} fps`).toBeLessThanOrEqual(26)
      expect(scrolls, `${fps} fps`).toBe(moved)
    }
  })

  it('stops at either end of the timeline, asking for no more frames', () => {
    const end = hold(800, second(60), 19150)
    expect(end.el.scrollLeft).toBe(19200)
    expect(frames).toEqual([])
    const start = hold(0, second(60), 30)
    expect(start.el.scrollLeft).toBe(0)
    expect(frames).toEqual([])
  })
})
