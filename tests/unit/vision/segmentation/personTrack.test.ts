import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { centroid } from '../../../../src/vision/mask/ops.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import { buildPersonTrack } from '../../../../src/vision/segmentation/personTrack.ts'
import type { JobProgress as Progress } from '../../../../src/shared/jobs.ts'
import { discMask, fakeBitmap, fakeOnnx, fakeSegmentation, fakeSource, timeOf } from './fakes.ts'

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', async (b: ImageBitmap) =>
    fakeBitmap(timeOf(b), { width: b.width, height: b.height }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildPersonTrack', () => {
  it('stores one mask per output frame at the requested size, with suitability and face observations', async () => {
    const { source, opened } = fakeSource({ duration: 2, frameRate: 25 })
    const seg = fakeSegmentation((t, s) => discMask(s, s.width * (0.3 + 0.2 * t), s.height / 2, s.height / 3))
    const progress: Progress[] = []
    const res = await buildPersonTrack({ segmentation: seg }, source, {
      faceFps: 5,
      onProgress: (p) => progress.push(p),
    })

    expect(res.track.meta).toMatchObject({
      fps: 25,
      start: 0,
      frameCount: 50,
      maskSize: { width: 512, height: 288 },
      kind: 'person',
      quality: 'standard',
    })
    expect(res.observations.map((o) => o.t)).toEqual(
      [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8].map((t) => expect.closeTo(t, 6)),
    )
    expect(res.observations[0]!.faces).toHaveLength(1)
    expect(res.suitability.verdict).toBe('good')
    expect(opened.every((b) => (b as unknown as { closed: boolean }).closed)).toBe(true)
    expect(progress.at(-1)!.fraction).toBe(1)
    const reader = createTrackReader(res.track)
    expect(centroid(reader.at(1.5))!.x).toBeCloseTo(0.6, 1)
  })

  it('defaults the frame rate to the source rate capped at 30 and picks the portrait model for vertical video', async () => {
    const { source } = fakeSource({ duration: 1, frameRate: 60, width: 720, height: 1280 })
    const seg = fakeSegmentation()
    const configure = vi.spyOn(seg, 'configure')
    const res = await buildPersonTrack({ segmentation: seg }, source, { faceFps: 0 })
    expect(res.track.meta.fps).toBe(30)
    expect(res.observations).toEqual([])
    expect(configure).toHaveBeenCalledWith({ model: 'selfie', delegate: 'CPU' }, expect.anything())
  })

  it('runs the high-quality matte only inside the requested ranges and keeps it only where it agrees', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 10 })
    const seg = fakeSegmentation()
    const onnx = fakeOnnx({
      // Agrees with the person before t = 1.5, then fails (blob in a corner).
      matte: (b) =>
        timeOf(b) < 1.5
          ? discMask({ width: 256, height: 144 }, 128, 72, 36)
          : discMask({ width: 256, height: 144 }, 10, 10, 8),
    })
    const res = await buildPersonTrack({ segmentation: seg, onnx }, source, {
      hqRanges: [{ start: 1, end: 1.8 }],
      faceFps: 0,
    })
    expect(onnx.calls.matte.map((t) => Math.round(t * 10))).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
    expect(res.hqFrames).toBe(5)
    expect(res.track.meta.quality).toBe('high')
  })

  it('cancels the worker track when aborted', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 10 })
    const seg = fakeSegmentation()
    const controller = new AbortController()
    const push = seg.pushTrackFrame.bind(seg)
    seg.pushTrackFrame = async (req) => {
      if (seg.pushed.length === 3) controller.abort()
      return push(req)
    }
    await expect(
      buildPersonTrack({ segmentation: seg }, source, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(seg.calls).toContain('cancelTrack')
    expect(seg.calls).not.toContain('endTrack')
  })

  it('fails with decode-failed and cleans up when frames cannot be decoded', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 10, failAt: 1 })
    const seg = fakeSegmentation()
    await expect(buildPersonTrack({ segmentation: seg }, source)).rejects.toMatchObject({ code: 'decode' })
    expect(seg.calls).toContain('cancelTrack')
  })

  it('requires an ONNX backend for high-quality ranges', async () => {
    const { source } = fakeSource({ duration: 1 })
    await expect(
      buildPersonTrack({ segmentation: fakeSegmentation() }, source, { hqRanges: [{ start: 0, end: 1 }] }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})
