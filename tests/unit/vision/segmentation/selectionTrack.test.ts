import { describe, expect, it } from 'vitest'
import type { SegmentationBackend, SelectRequest } from '../../../../src/vision/backends.ts'
import { centroid, coverage } from '../../../../src/vision/mask/ops.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import { buildSelectionTrack } from '../../../../src/vision/segmentation/selectionTrack.ts'
import type { Mask, Size } from '../../../../src/vision/types.ts'
import { fakeSegmentation, fakeSource, flatGray, timeOf } from './fakes.ts'

/** A square that moves right by `speed` (normalized per second) and exists while `visible(t)`. */
function squareAt(t: number, speed: number) {
  return { x: 0.2 + speed * t, y: 0.4, size: 0.2 }
}

function selectorFor(opts: { speed: number; visible?: (t: number) => boolean; extraBlob?: boolean }) {
  const seg = fakeSegmentation()
  const prompts: Array<{ t: number; points: number }> = []
  seg.select = async (req: SelectRequest): Promise<Mask> => {
    const t = timeOf(req.bitmap)
    req.bitmap.close()
    const size: Size = req.maskSize!
    const data = new Uint8Array(size.width * size.height)
    const sq = squareAt(t, opts.speed)
    const hit =
      (opts.visible?.(t) ?? true) &&
      req.points.some((p) => p.x >= sq.x && p.x <= sq.x + sq.size && p.y >= sq.y && p.y <= sq.y + sq.size)
    prompts.push({ t, points: req.points.length })
    if (hit) {
      for (let y = 0; y < size.height; y++)
        for (let x = 0; x < size.width; x++) {
          const u = (x + 0.5) / size.width
          const v = (y + 0.5) / size.height
          if (u >= sq.x && u <= sq.x + sq.size && v >= sq.y && v <= sq.y + sq.size)
            data[y * size.width + x] = 255
        }
    }
    return { width: size.width, height: size.height, data }
  }
  return { seg: seg as SegmentationBackend, prompts }
}

const toGray = (_b: ImageBitmap, size: Size) => flatGray(size, 90)

describe('buildSelectionTrack', () => {
  it('follows a moving object forwards and backwards from the click', async () => {
    const { source } = fakeSource({ duration: 2, width: 640, height: 360 })
    const { seg, prompts } = selectorFor({ speed: 0.1 })
    const click = { t: 1, points: [{ x: 0.4, y: 0.5 }] }
    const res = await buildSelectionTrack({ segmentation: seg, toGray }, source, click, {
      fps: 10,
      maxSide: 160,
    })
    expect(res.track.meta).toMatchObject({
      kind: 'selection',
      fps: 10,
      start: 0,
      frameCount: 20,
      lostFrames: [],
    })
    expect(res.trackedFraction).toBe(1)
    expect(prompts[0]).toEqual({ t: 1, points: 1 })
    const reader = createTrackReader(res.track)
    for (const t of [0, 0.5, 1.5, 1.9])
      expect(centroid(reader.at(t))!.x).toBeCloseTo(squareAt(t, 0.1).x + 0.1, 1)
  })

  it('marks frames lost when the object disappears and drops it after a second', async () => {
    const { source } = fakeSource({ duration: 3, width: 640, height: 360 })
    const { seg } = selectorFor({ speed: 0, visible: (t) => t < 1.05 })
    const res = await buildSelectionTrack(
      { segmentation: seg, toGray },
      source,
      { t: 0.5, points: [{ x: 0.3, y: 0.5 }] },
      { fps: 10, maxSide: 160 },
    )
    const lost = res.track.meta.lostFrames!
    expect(lost[0]).toBe(11)
    expect(lost).toHaveLength(30 - 11)
    const reader = createTrackReader(res.track)
    // Held at the predicted position for up to a second, then empty.
    expect(coverage(reader.frame(15))).toBeGreaterThan(0)
    expect(coverage(reader.frame(25))).toBe(0)
  })

  it('rejects a click that selects nothing', async () => {
    const { source } = fakeSource({ duration: 1, width: 640, height: 360 })
    const { seg } = selectorFor({ speed: 0 })
    await expect(
      buildSelectionTrack(
        { segmentation: seg, toGray },
        source,
        { t: 0.5, points: [{ x: 0.9, y: 0.9 }] },
        { maxSide: 160 },
      ),
    ).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })
})
