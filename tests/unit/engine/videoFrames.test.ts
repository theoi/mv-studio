import { afterEach, describe, expect, it, vi } from 'vitest'
import { VideoElementFrameProvider } from '../../../src/engine/frames.ts'
import type { Asset } from '../../../src/model/types.ts'

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void

/** A paused <video> that seeks in 10 ms and presents the new frame before or 30 ms after 'seeked'. */
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
  present: 'before' | 'after' = 'before'
  /** The media time of the frame presented for a seek to `t`. */
  shows = (t: number) => t
  private time = 0
  private callbacks: FrameCallback[] = []

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
    setTimeout(() => {
      if (this.present === 'before') this.presentFrame(t)
      this.seeking = false
      this.dispatchEvent(new Event('seeked'))
      if (this.present === 'after') setTimeout(() => this.presentFrame(t), 30)
    }, 10)
  }

  requestVideoFrameCallback(callback: FrameCallback): number {
    this.callbacks.push(callback)
    return this.callbacks.length
  }

  private presentFrame(t: number): void {
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

  removeAttribute(): void {}
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

/** How long a paused frame request takes, in ms (-1 if it has not resolved after 300 ms). */
async function pausedFrameMs(video: FakeVideo, sourceTime = 4): Promise<number> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('document', { createElement: () => video })
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 })
  const provider = new VideoElementFrameProvider({ getFile: async () => new Blob() })
  provider.setPlaying(false)
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
    video.present = 'after'
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

  it('does not take another frame presented during the seek for the new one', async () => {
    const video = new FakeVideo()
    // A frame from where the video was before (e.g. its playback, just paused), and none after the seek.
    video.shows = (t) => t + 3
    const ms = await pausedFrameMs(video)
    expect(ms).toBeGreaterThanOrEqual(120)
  })
})
