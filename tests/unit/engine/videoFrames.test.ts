import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgedFrameProvider, VideoElementFrameProvider } from '../../../src/engine/frames.ts'
import type { Asset } from '../../../src/model/types.ts'

type FrameCallback = (now: number, metadata: { mediaTime: number; presentationTime: number }) => void

/**
 * A paused <video> that seeks in `seekMs` (10 ms). As in Chrome, each seek's frame goes to the compositor as the seek ends, before
 * 'seeked' (the frame's presentationTime), and its frame callback runs then or some time after.
 */
class FakeVideo extends EventTarget {
  muted = false
  playsInline = false
  preload = ''
  paused = true
  seeking = false
  readyState = 0
  videoWidth = 1920
  videoHeight = 1080
  playbackRate = 1
  /** How long a seek takes, in ms. */
  seekMs = 10
  /** How long after 'seeked' the frame callback for a seek to `t` runs, or null for just before it. */
  presentAfter = (_t: number): number | null => null
  /** The media time of the frame presented for a seek to `t`. */
  shows = (t: number) => t
  /** How long after 'loadeddata' the callback of the first frame (presented before it) runs, or null for never. */
  firstFrameAfter: number | null = null
  /** Frames of seeks whose callbacks ran: the seek they were for, and when. */
  readonly presented: { t: number; at: number }[] = []
  /** Every time currentTime was set: the time, and when. */
  readonly sets: { t: number; at: number }[] = []
  /** How many seeks, from the next one, the element drops: they never end. */
  dropSeeks = 0
  private time = 0
  private seeks = 0
  private callbacks: FrameCallback[] = []

  /** Set once the element let go of its media. */
  released = false

  set src(_url: string) {
    setTimeout(() => {
      const presentedAt = performance.now()
      setTimeout(() => {
        this.readyState = 2
        this.dispatchEvent(new Event('loadeddata'))
        const after = this.firstFrameAfter
        if (after !== null) setTimeout(() => this.runCallbacks(this.shows(0), presentedAt), after)
      }, 1)
    }, 4)
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(t: number) {
    this.time = t
    this.seeking = true
    this.sets.push({ t, at: performance.now() })
    const seek = ++this.seeks
    if (this.dropSeeks > 0) {
      this.dropSeeks--
      return
    }
    const after = this.presentAfter(t)
    setTimeout(() => {
      const presentedAt = performance.now()
      const present = () => {
        this.presented.push({ t, at: performance.now() })
        this.runCallbacks(this.shows(t), presentedAt)
      }
      if (after === null) present()
      else setTimeout(present, after)
      // A seek made while another was under way ends both, with one 'seeked'.
      if (seek !== this.seeks) return
      this.seeking = false
      this.dispatchEvent(new Event('seeked'))
    }, this.seekMs)
  }

  /** Playback reaching `t`, presenting its frame. */
  playTo(t: number): void {
    this.time = t
    this.runCallbacks(this.shows(t), performance.now())
  }

  /** Runs the frame callbacks for a frame of media time `mediaTime` that went to the compositor at `presentedAt`. */
  runCallbacks(mediaTime: number, presentedAt: number): void {
    const callbacks = this.callbacks
    this.callbacks = []
    for (const callback of callbacks)
      callback(performance.now(), { mediaTime, presentationTime: presentedAt })
  }

  requestVideoFrameCallback(callback: FrameCallback): number {
    this.callbacks.push(callback)
    return this.callbacks.length
  }

  pause(): void {
    this.paused = true
  }

  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.released = true
  }
  load(): void {}
}

const asset = {
  id: 'a',
  kind: 'video',
  name: 'a.mp4',
  storageKey: 'a',
  duration: 10,
  frameRate: 30,
  width: 1920,
  height: 1080,
} as Asset

/** A paused preview's frame provider whose <video> elements are `video`. */
function pausedProvider(
  video: FakeVideo,
  options: ConstructorParameters<typeof VideoElementFrameProvider>[1] = {},
): VideoElementFrameProvider {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('document', { createElement: () => video })
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
  // Animation frames every 16 ms.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  )
  const provider = new VideoElementFrameProvider({ getFile: async () => new Blob() }, options)
  provider.setPlaying(false)
  return provider
}

/** How long a paused frame request takes, in ms (-1 if it has not resolved after 300 ms). */
async function pausedFrameMs(video: FakeVideo, sourceTime = 4): Promise<number> {
  const provider = pausedProvider(video)
  const start = performance.now()
  let ms = -1
  void provider.videoFrame(asset, sourceTime, 'clip').then(() => (ms = performance.now() - start))
  await vi.advanceTimersByTimeAsync(300)
  provider.dispose()
  return ms
}

describe('seeking a paused preview video', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns as soon as the seek ends when the new frame was presented before it ended', async () => {
    const ms = await pausedFrameMs(new FakeVideo())
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(60)
  })

  it('waits for the new frame when its callback runs after the seek ends', async () => {
    const video = new FakeVideo()
    video.presentAfter = () => 30
    const ms = await pausedFrameMs(video)
    expect(ms).toBeGreaterThanOrEqual(40)
    expect(ms).toBeLessThan(100)
  })

  it('also returns at once for low frame rate footage, whose frame starts well before the requested time', async () => {
    const video = new FakeVideo()
    // 2 fps footage, though the asset reports 30 fps: a seek to 4.3 s shows the frame at 4 s.
    video.shows = (t) => Math.floor(t * 2) / 2
    const ms = await pausedFrameMs(video, 4.3)
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(60)
  })

  it.each([
    { name: 'a new element seeking within its first frame', times: [0.2] },
    { name: 'a step within the frame the seek before showed', times: [4, 4.3] },
  ])('returns at once going forward within one frame of 2 fps footage: $name', async ({ times }) => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 2) / 2
    const lowRate = { ...asset, frameRate: 2 }
    const provider = pausedProvider(video)
    for (const t of times.slice(0, -1)) {
      void provider.videoFrame(lowRate, t, 'clip')
      await vi.advanceTimersByTimeAsync(300)
    }
    const start = performance.now()
    let ms = -1
    void provider.videoFrame(lowRate, times.at(-1)!, 'clip').then(() => (ms = performance.now() - start))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(60)
  })

  it('returns at once for a step forward within the frame shown when playback pauses', async () => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 30 + 1e-9) / 30
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(5)
    video.playTo(4.51)
    await vi.advanceTimersByTimeAsync(10)
    provider.setPlaying(false)
    const start = performance.now()
    let ms = -1
    void provider.videoFrame(asset, 4.52, 'clip').then(() => (ms = performance.now() - start))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(60)
  })

  it('does not take another frame presented during the seek for the new one', async () => {
    const video = new FakeVideo()
    // A frame from where the video was before (e.g. its playback, just paused), and none after the seek.
    video.shows = (t) => t + 3
    const ms = await pausedFrameMs(video)
    expect(ms).toBeGreaterThanOrEqual(120)
  })

  it('does not take a late frame of the seek before for the new one, going forward by less than a second', async () => {
    const video = new FakeVideo()
    // The seek to 4.5 s presents its frame as it ends, but the frame's callback runs 125 ms later, once that seek's
    // wait (120 ms) is over and the next seek has started.
    video.presentAfter = (t) => (t < 4.75 ? 125 : 30)
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4.5, 'clip')
    await vi.advanceTimersByTimeAsync(20)
    let resolvedAt = -1
    void provider.videoFrame(asset, 5, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(400)
    provider.dispose()
    const own = video.presented.find((p) => p.t > 4.75)
    expect(video.presented[0]?.t).toBeLessThan(4.75)
    expect(own).toBeDefined()
    expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
  })

  it.each([
    { reports: 29.9, has: 30 },
    { reports: 30, has: 60 },
  ])(
    'does not take a late frame of the seek before for the next frame of footage reporting $reports fps that has $has fps there',
    async ({ reports, has }) => {
      const video = new FakeVideo()
      video.shows = (t) => Math.floor(t * has + 1e-9) / has
      // The seek to 4 s presents its frame as it ends, but the frame's callback runs 125 ms later, once that seek's
      // wait (120 ms) is over and the next seek has started.
      video.presentAfter = (t) => (t < 4.01 ? 125 : 30)
      const footage = { ...asset, frameRate: reports }
      const provider = pausedProvider(video)
      void provider.videoFrame(footage, 4, 'clip')
      await vi.advanceTimersByTimeAsync(20)
      let resolvedAt = -1
      void provider.videoFrame(footage, 4 + 1 / has, 'clip').then(() => (resolvedAt = performance.now()))
      await vi.advanceTimersByTimeAsync(400)
      provider.dispose()
      const own = video.presented.find((p) => p.t > 4.01)
      expect(video.presented[0]?.t).toBeLessThan(4.01)
      expect(own).toBeDefined()
      expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
    },
  )

  it('keeps waiting when a late frame of the seek before comes while the new seek waits for its own', async () => {
    const video = new FakeVideo()
    // The seek to 4.5 s presents its frame as it ends, but the frame's callback runs 140 ms later: after that seek's
    // wait (120 ms), and after the next seek ends, while it waits for its own frame's callback (40 ms after it ends).
    video.presentAfter = (t) => (t < 4.75 ? 140 : 40)
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4.5, 'clip')
    await vi.advanceTimersByTimeAsync(20)
    let resolvedAt = -1
    void provider.videoFrame(asset, 5, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(400)
    provider.dispose()
    const late = video.presented.find((p) => p.t < 4.75)
    const own = video.presented.find((p) => p.t > 4.75)
    expect(late).toBeDefined()
    expect(own).toBeDefined()
    expect(own!.at).toBeGreaterThan(late!.at)
    expect(resolvedAt).toBeGreaterThanOrEqual(own!.at)
  })

  it('does not take a frame from playback, presented after the pause, for the next frame', async () => {
    const video = new FakeVideo()
    // 60 fps footage, though the asset reports 30 fps.
    video.shows = (t) => Math.floor(t * 60 + 1e-9) / 60
    // Starting playback seeks to 4.5 s; that frame's callback runs 8 ms after the seek ends, once paused again and the
    // next seek has started.
    video.presentAfter = (t) => (t > 4.49 && t < 4.51 ? 8 : 30)
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4.5, 'clip')
    await vi.advanceTimersByTimeAsync(12)
    provider.setPlaying(false)
    let resolvedAt = -1
    void provider.videoFrame(asset, 4.5 + 1 / 60, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    const own = video.presented.find((p) => p.t > 4.51)
    expect(video.presented.some((p) => p.t > 4.49 && p.t < 4.51)).toBe(true)
    expect(own).toBeDefined()
    expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
  })

  it('does not take a frame from playback that was in flight at the pause, past where the video paused', async () => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 30 + 1e-9) / 30
    video.presentAfter = () => 30
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(5)
    video.playTo(4.4)
    // The next frame goes to the compositor 5 ms before the pause, and its callback runs once the seek after the pause
    // has ended.
    await vi.advanceTimersByTimeAsync(10)
    const inFlight = performance.now()
    await vi.advanceTimersByTimeAsync(5)
    provider.setPlaying(false)
    let resolvedAt = -1
    void provider.videoFrame(asset, 5.2, 'clip').then(() => (resolvedAt = performance.now()))
    setTimeout(() => video.runCallbacks(4.4 + 1 / 30, inFlight), 30)
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    const own = video.presented.find((p) => p.t > 5)
    expect(own).toBeDefined()
    expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
  })

  it('does not take the frame of a seek still under way when it started, going forward', async () => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 30 + 1e-9) / 30
    // warm() seeks the element to 6 s for a clip about to start, and the next seek starts before that one ends. Its frame
    // goes to the compositor as it ends, after the next seek started, with a callback 20 ms later; the next seek's frame
    // callback runs 40 ms after it ends.
    video.presentAfter = (t) => (t < 6.25 ? 20 : 40)
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.warm([{ asset, sourceTime: 6, key: 'clip', startsIn: 2, rate: 1 }])
    let resolvedAt = -1
    void provider.videoFrame(asset, 6.5, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    const earlier = video.presented.find((p) => p.t > 5.9 && p.t < 6.25)
    const own = video.presented.find((p) => p.t > 6.25)
    expect(earlier).toBeDefined()
    expect(own).toBeDefined()
    expect(own!.at).toBeGreaterThan(earlier!.at)
    expect(resolvedAt).toBeGreaterThanOrEqual(own!.at)
  })

  it('takes its own frame after the playback frames that still come once playback pauses, under load', async () => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 30 + 1e-9) / 30
    // Busy with other videos, the pipeline takes 30 ms for the seek, and the seek's frame callback runs 4 ms after it.
    video.seekMs = 30
    video.presentAfter = () => 4
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(5)
    video.playTo(4.4)
    await vi.advanceTimersByTimeAsync(10)
    // Two more playback frames go to the compositor 1 and 20 ms after the pause, after the seek started.
    for (const [after, frame] of [
      [1, 1],
      [20, 2],
    ])
      setTimeout(() => video.runCallbacks(4.4 + frame / 30, performance.now()), after)
    provider.setPlaying(false)
    let resolvedAt = -1
    void provider.videoFrame(asset, 5.2, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    const own = video.presented.find((p) => p.t > 5)
    expect(own).toBeDefined()
    expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
  })

  it('does not wait for an animation frame when playback paused well before the seek', async () => {
    const video = new FakeVideo()
    const provider = pausedProvider(video)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(5)
    video.playTo(4.4)
    provider.setPlaying(false)
    await vi.advanceTimersByTimeAsync(300)
    const start = performance.now()
    let ms = -1
    void provider.videoFrame(asset, 5.2, 'clip').then(() => (ms = performance.now() - start))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThan(16)
  })

  it('still seeks right after a pause where animation frames do not run (a hidden page)', async () => {
    const video = new FakeVideo()
    const provider = pausedProvider(video)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(100)
    provider.setPlaying(true)
    void provider.videoFrame(asset, 4, 'clip')
    await vi.advanceTimersByTimeAsync(5)
    provider.setPlaying(false)
    const start = performance.now()
    let ms = -1
    void provider.videoFrame(asset, 5.2, 'clip').then(() => (ms = performance.now() - start))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    expect(ms).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(100)
  })

  it('does not take a new element’s first frame for its first seek when that frame’s callback runs late', async () => {
    const video = new FakeVideo()
    video.shows = (t) => Math.floor(t * 30 + 1e-9) / 30
    // The first frame goes to the compositor before 'loadeddata'; its callback runs after the first seek ends.
    video.firstFrameAfter = 13
    video.presentAfter = () => 30
    const provider = pausedProvider(video)
    let resolvedAt = -1
    void provider.videoFrame(asset, 0.5, 'clip').then(() => (resolvedAt = performance.now()))
    await vi.advanceTimersByTimeAsync(300)
    provider.dispose()
    const own = video.presented.find((p) => p.t > 0.4)
    expect(own).toBeDefined()
    expect(resolvedAt).toBeGreaterThanOrEqual(own?.at ?? Infinity)
  })
})

describe('a paused frame’s seek that outlasts the frame’s wait for it (5 s)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** A paused provider whose element takes `seekMs` to seek, and the redraws it asks for. */
  function slowSeeks(seekMs: number, dropSeeks = 0) {
    const video = new FakeVideo()
    video.seekMs = seekMs
    video.dropSeeks = dropSeeks
    const onLateFrame = vi.fn()
    const provider = pausedProvider(video, { onLateFrame })
    return { video, provider, onLateFrame, start: performance.now() }
  }

  /** Asks for the frame of `key` at `t` as the preview does; resolves once it is drawn. */
  async function draw(provider: VideoElementFrameProvider, t: number, key = 'clip') {
    provider.beginFrame([key])
    let drawn = false
    void provider.videoFrame(asset, t, key).then(() => (drawn = true))
    while (!drawn) await vi.advanceTimersByTimeAsync(50)
    provider.endFrame()
  }

  const ago = (start: number, at: number | undefined) => Math.round(((at ?? Infinity) - start) / 1000)

  it('ends, as the frames drawn meanwhile wait for it instead of sending the element there again', async () => {
    const { video, provider, start } = slowSeeks(12_000)
    // Edits elsewhere (footage analysis, say) draw the paused frame again, one frame at a time, 2 s apart.
    while (performance.now() - start < 40_000) {
      await draw(provider, 4)
      await vi.advanceTimersByTimeAsync(2000)
    }
    provider.dispose()
    expect(video.sets.map((s) => s.t)).toEqual([expect.closeTo(4, 3)])
    expect(ago(start, video.presented.find((p) => Math.abs(p.t - 4) < 0.01)?.at)).toBe(12)
    expect(video.seeking).toBe(false)
  })

  it.each([
    { on: 'still on screen', next: 'clip', redraws: 1 },
    { on: 'gone from the frame since', next: 'other', redraws: 0 },
  ])('asks for a redraw once it ends, for a clip $on', async ({ next, redraws }) => {
    const { provider, onLateFrame, start } = slowSeeks(12_000)
    await draw(provider, 4)
    expect(ago(start, performance.now())).toBe(5)
    provider.beginFrame([next])
    provider.endFrame()
    await vi.advanceTimersByTimeAsync(6000)
    expect(onLateFrame).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    provider.dispose()
    expect(onLateFrame).toHaveBeenCalledTimes(redraws)
  })

  it('asks for no redraw after a seek that ended in time', async () => {
    const { provider, onLateFrame } = slowSeeks(300)
    await draw(provider, 4)
    await vi.advanceTimersByTimeAsync(30_000)
    provider.dispose()
    expect(onLateFrame).not.toHaveBeenCalled()
  })

  it('still sends the element at once to a new time asked for meanwhile', async () => {
    const { video, provider, onLateFrame, start } = slowSeeks(12_000)
    await draw(provider, 4)
    const asked = performance.now()
    await draw(provider, 7)
    await vi.advanceTimersByTimeAsync(10_000)
    provider.dispose()
    expect(video.sets.map((s) => s.t)).toEqual([expect.closeTo(4, 3), expect.closeTo(7, 3)])
    expect(video.sets[1]!.at - asked).toBeLessThan(1)
    expect(ago(start, video.presented.find((p) => Math.abs(p.t - 7) < 0.01)?.at)).toBe(17)
    expect(video.seeking).toBe(false)
    // For the seek to 7 s, whose frame was drawn without it too; the seek to 4 s it replaced asks for none.
    expect(onLateFrame).toHaveBeenCalledTimes(1)
  })

  it('sends a seek the element dropped again after 20 s, then after 40 s more, and asks for a redraw once it ends', async () => {
    const { video, provider, onLateFrame, start } = slowSeeks(100, 2)
    await draw(provider, 4)
    await vi.advanceTimersByTimeAsync(70_000)
    provider.dispose()
    expect(video.sets.map((s) => ago(start, s.at))).toEqual([0, 20, 60])
    expect(video.sets.every((s) => Math.abs(s.t - 4) < 0.01)).toBe(true)
    expect(video.seeking).toBe(false)
    expect(onLateFrame).toHaveBeenCalledTimes(1)
  })
})

/** A paused preview's frame provider that makes a new element each time; `created` lists them in order. */
function providerMakingElements(): { provider: VideoElementFrameProvider; created: FakeVideo[] } {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const created: FakeVideo[] = []
  vi.stubGlobal('document', {
    createElement: () => {
      const video = new FakeVideo()
      created.push(video)
      return video
    },
  })
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
  // Animation frames every 16 ms.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  )
  const provider = new VideoElementFrameProvider({ getFile: async () => new Blob() })
  provider.setPlaying(false)
  return { provider, created }
}

/** Draws one paused frame of `requests` (key and source time) and returns its sources by key. */
async function frame(provider: VideoElementFrameProvider, requests: [key: string, t: number][]) {
  provider.beginFrame(requests.map(([key]) => key))
  const refs = requests.map(([key, t]) => provider.videoFrame(asset, t, key))
  await vi.advanceTimersByTimeAsync(200)
  provider.endFrame()
  return new Map((await Promise.all(refs)).map((ref, i) => [requests[i]![0], ref?.source]))
}

describe('keeping an element ready for a transition near the paused playhead', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads and seeks one ahead, which a seek into the transition then uses instead of loading another', async () => {
    const { provider, created } = providerMakingElements()
    await frame(provider, [['a', 1]])
    expect(created).toHaveLength(1)
    provider.prewarm([{ asset, sourceTime: 3.9, key: 'b' }])
    await vi.advanceTimersByTimeAsync(200)
    expect(created).toHaveLength(2)
    expect(created[1]!.currentTime).toBeCloseTo(3.9, 3)
    const shown = await frame(provider, [
      ['a', 1.1],
      ['b', 3.95],
    ])
    expect(created).toHaveLength(2)
    expect(shown.get('b')).toBe(created[1])
    provider.dispose()
  })

  it('lets it go once the playhead moves away, but not while the frame on screen shows it', async () => {
    const { provider, created } = providerMakingElements()
    provider.prewarm([{ asset, sourceTime: 3.9, key: 'b' }])
    await vi.advanceTimersByTimeAsync(200)
    const ready = created[0]!
    // On screen: the playhead moved into the transition, so the element is no longer kept for it, but is in use.
    await frame(provider, [['b', 3.95]])
    provider.prewarm([])
    expect(ready.released).toBe(false)

    provider.prewarm([{ asset, sourceTime: 3.9, key: 'c' }])
    await vi.advanceTimersByTimeAsync(200)
    const other = created.at(-1)!
    expect(other).not.toBe(ready)
    await frame(provider, [['b', 1]])
    provider.prewarm([])
    expect(other.released).toBe(true)
    expect(ready.released).toBe(false)
    provider.dispose()
  })

  it('does not hand it to another clip of the same footage that needs an element meanwhile', async () => {
    const { provider, created } = providerMakingElements()
    provider.prewarm([{ asset, sourceTime: 3.9, key: 'b' }])
    await vi.advanceTimersByTimeAsync(200)
    const shown = await frame(provider, [['c', 2]])
    expect(created).toHaveLength(2)
    expect(shown.get('c')).toBe(created[1])
    expect(created[0]!.currentTime).toBeCloseTo(3.9, 3)
    provider.dispose()
  })
})

describe('two clips showing the same frame of the same footage while paused', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const seeks = (videos: FakeVideo[]) => videos.reduce((n, v) => n + v.presented.length, 0)

  it('share one seek, and each keeps its own element loaded', async () => {
    const { provider, created } = providerMakingElements()
    const shown = await frame(provider, [
      ['a', 3],
      ['b', 3],
    ])
    expect(created).toHaveLength(2)
    expect(created.every((v) => v.readyState === 2)).toBe(true)
    expect(seeks(created)).toBe(1)
    expect(shown.get('b')).toBe(shown.get('a'))
    provider.dispose()
  })

  it('part again when their times differ, each showing its own element at its own time', async () => {
    const { provider, created } = providerMakingElements()
    await frame(provider, [
      ['a', 3],
      ['b', 3],
    ])
    const shown = await frame(provider, [
      ['a', 3],
      ['b', 5],
    ])
    const [a, b] = [shown.get('a') as unknown as FakeVideo, shown.get('b') as unknown as FakeVideo]
    expect(a).not.toBe(b)
    expect(b).toBe(created[1])
    expect(a.currentTime).toBeCloseTo(3, 3)
    expect(b.currentTime).toBeCloseTo(5, 3)
    provider.dispose()
  })

  it('share only within a frame: a later frame seeks again rather than take the earlier frame’s element', async () => {
    const { provider } = providerMakingElements()
    const first = await frame(provider, [
      ['a', 3],
      ['b', 3],
    ])
    const shared = first.get('a') as unknown as FakeVideo
    const shown = await frame(provider, [
      ['a', 6],
      ['b', 3],
    ])
    const b = shown.get('b') as unknown as FakeVideo
    expect(shared.currentTime).toBeCloseTo(6, 3)
    expect(b).not.toBe(shared)
    expect(b.currentTime).toBeCloseTo(3, 3)
    provider.dispose()
  })
})

describe('the render worker’s frames of two clips that showed the same frame', () => {
  it('closes each clip’s own frame once: when that clip gets a new one, leaves, or the preview closes', () => {
    const frame = () => ({ close: vi.fn() }) as unknown as VideoFrame
    const [a1, b1, a2] = [frame(), frame(), frame()]
    const bridged = new BridgedFrameProvider({ getFile: async () => new Blob() })
    bridged.set([
      { key: 'a', frame: a1, width: 640, height: 360 },
      { key: 'b', frame: b1, width: 640, height: 360 },
    ])
    bridged.set([
      { key: 'a', frame: a2, width: 640, height: 360 },
      { key: 'b', frame: null, width: 640, height: 360, same: true },
    ])
    expect(a1.close).toHaveBeenCalledTimes(1)
    expect(b1.close).not.toHaveBeenCalled()
    bridged.set([{ key: 'a', frame: null, width: 640, height: 360, same: true }])
    expect(b1.close).toHaveBeenCalledTimes(1)
    expect(a2.close).not.toHaveBeenCalled()
    bridged.dispose()
    expect([a1, b1, a2].map((f) => vi.mocked(f.close).mock.calls.length)).toEqual([1, 1, 1])
  })
})
