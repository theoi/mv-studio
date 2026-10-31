import { describe, expect, it } from 'vitest'
import type { FrameAnalysis, FrameAnalysisRequest } from '../../../../src/vision/backends.ts'
import { createLivePreview } from '../../../../src/vision/segmentation/preview.ts'
import { discMask, fakeBitmap, fakeSegmentation, flatGray, timeOf } from './fakes.ts'

const SIZE = { width: 32, height: 18 }

function controllableBackend() {
  const seg = fakeSegmentation()
  const pending: Array<{ t: number; resolve: () => void }> = []
  const resets: number[] = []
  seg.analyze = (req: FrameAnalysisRequest) =>
    new Promise<FrameAnalysis>((resolve) => {
      const t = timeOf(req.bitmap)
      req.bitmap.close()
      pending.push({
        t,
        resolve: () => resolve({ mask: discMask(SIZE, 16, 9, t * 10), gray: flatGray(SIZE) }),
      })
    })
  seg.resetStream = async () => {
    resets.push(1)
  }
  return { seg, pending, resets }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('live preview segmenter', () => {
  it('drops frames that were superseded while the model was busy', async () => {
    const { seg, pending } = controllableBackend()
    const preview = createLivePreview(seg, { smoothing: false })
    const b2 = fakeBitmap(0.1, SIZE)
    const r1 = preview.segment(fakeBitmap(0, SIZE), 0)
    const r2 = preview.segment(b2, 0.1)
    const r3 = preview.segment(fakeBitmap(0.2, SIZE), 0.2)
    expect(await r2).toBeNull()
    expect((b2 as unknown as { closed: boolean }).closed).toBe(true)
    pending.shift()!.resolve()
    expect(await r1).not.toBeNull()
    await tick()
    expect(pending.map((p) => p.t)).toEqual([0.2])
    pending.shift()!.resolve()
    expect((await r3)!.width).toBe(32)
  })

  it('smooths consecutive frames and restarts smoothing after a seek', async () => {
    const { seg, pending } = controllableBackend()
    const preview = createLivePreview(seg)
    const run = async (t: number) => {
      const p = preview.segment(fakeBitmap(t, SIZE), t)
      await tick()
      pending.shift()!.resolve()
      return (await p)!
    }
    await run(0.4)
    const smoothed = await run(0.5)
    const raw = discMask(SIZE, 16, 9, 5)
    expect(smoothed.data).not.toEqual(raw.data)
    const afterSeek = await run(0.1)
    expect(afterSeek.data).toEqual(discMask(SIZE, 16, 9, 1).data)
  })

  it('resolves pending frames with null after dispose', async () => {
    const { seg } = controllableBackend()
    const preview = createLivePreview(seg)
    void preview.segment(fakeBitmap(0, SIZE), 0)
    const queued = preview.segment(fakeBitmap(0.1, SIZE), 0.1)
    preview.dispose()
    expect(await queued).toBeNull()
    expect(await preview.segment(fakeBitmap(0.2, SIZE), 0.2)).toBeNull()
  })
})
