import { afterEach, describe, expect, it, vi } from 'vitest'
import { VideoElementFrameProvider } from '../../../src/engine/frames.ts'
import type { Asset } from '../../../src/model/types.ts'

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void

/** A paused <video> that seeks in 10 ms and presents the new frame before 'seeked' or some time after it. */
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
  /** How long after 'seeked' the frame for a seek to `t` is presented, or null for just before it. */
  presentAfter = (_t: number): number | null => null
  /** The media time of the frame presented for a seek to `t`. */
  shows = (t: number) => t
  /** Frames presented: the seek they were for, and when. */
  readonly presented: { t: number; at: number }[] = []
  private time = 0
  private callbacks: FrameCallback[] = []

  /** Set once the element let go of its media. */
  released = false

  set src(_url: string) {
    setTimeout(() => {
      this.readyState = 2
      this.dispatchEvent(new Event('loadeddata'))
    }, 5)
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(t: number) {
    this.time = t
    this.seeking = true
    const after = this.presentAfter(t)
    setTimeout(() => {
      if (after === null) this.presentFrame(t)
      this.seeking = false
      this.dispatchEvent(new Event('seeked'))
      if (after !== null) setTimeout(() => this.presentFrame(t), after)
    }, 10)
  }

  requestVideoFrameCallback(callback: FrameCallback): number {
    this.callbacks.push(callback)
    return this.callbacks.length
  }

  private presentFrame(t: number): void {
    this.presented.push({ t, at: performance.now() })
    const callbacks = this.callbacks
    this.callbacks = []
    for (const callback of callbacks) callback(performance.now(), { mediaTime: this.shows(t) })
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
function pausedProvider(video: FakeVideo): VideoElementFrameProvider {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('document', { createElement: () => video })
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
  const provider = new VideoElementFrameProvider({ getFile: async () => new Blob() })
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

  it('waits for the new frame when it is presented after the seek ends', async () => {
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

  it('does not take another frame presented during the seek for the new one', async () => {
    const video = new FakeVideo()
    // A frame from where the video was before (e.g. its playback, just paused), and none after the seek.
    video.shows = (t) => t + 3
    const ms = await pausedFrameMs(video)
    expect(ms).toBeGreaterThanOrEqual(120)
  })

  it('does not take a late frame of the seek before for the new one, going forward by less than a second', async () => {
    const video = new FakeVideo()
    // The seek to 4.5 s presents its frame 125 ms after it ends, once its own wait (120 ms) is over.
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
      // The seek to 4 s presents its frame 125 ms after it ends, once its own wait (120 ms) is over.
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

  it('does not take a frame from playback, presented after the pause, for the next frame', async () => {
    const video = new FakeVideo()
    // 60 fps footage, though the asset reports 30 fps.
    video.shows = (t) => Math.floor(t * 60 + 1e-9) / 60
    // Starting playback seeks to 4.5 s; that frame is presented 8 ms after the seek ends, once paused again.
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
