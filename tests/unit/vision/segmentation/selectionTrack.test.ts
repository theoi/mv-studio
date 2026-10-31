import { describe, expect, it } from 'vitest'
import type { SegmentationBackend, SelectRequest } from '../../../../src/vision/backends.ts'
import { centroid, coverage } from '../../../../src/vision/mask/ops.ts'
import { createTrackReader } from '../../../../src/vision/mask/track.ts'
import {
  buildSelectionTrack,
  selectionStateAt,
  type SelectionDeps,
  type SelectionTrackResult,
} from '../../../../src/vision/segmentation/selectionTrack.ts'
import type { Mask, Point, RgbaImage, Size } from '../../../../src/vision/types.ts'
import { fakeSegmentation, fakeSource, flatGray, timeOf } from './fakes.ts'

interface Square {
  x: number
  y: number
  size: number
  color: [number, number, number]
}

/** Squares in the picture at time t; later ones are in front. */
type World = (t: number) => Square[]

const RED: [number, number, number] = [220, 40, 40]
const BLUE: [number, number, number] = [40, 60, 220]

const inside = (s: Square, u: number, v: number) =>
  u >= s.x && u <= s.x + s.size && v >= s.y && v <= s.y + s.size

/** Index of the frontmost square at a normalized point, or -1. */
function frontAt(squares: Square[], u: number, v: number): number {
  for (let k = squares.length - 1; k >= 0; k--) if (inside(squares[k]!, u, v)) return k
  return -1
}

/**
 * Stand-in for the selector: selects the visible parts of the squares the points land on (several when the
 * points land on several, like a scribble across two objects). Also renders the world for the colour model.
 */
function fakeWorld(world: World) {
  const seg = fakeSegmentation()
  const prompts: Array<{ t: number; points: Point[] }> = []
  seg.select = async (req: SelectRequest): Promise<Mask> => {
    const t = timeOf(req.bitmap)
    req.bitmap.close()
    prompts.push({ t, points: req.points })
    const size: Size = req.maskSize!
    const squares = world(t)
    const hit = new Set(req.points.map((p) => frontAt(squares, p.x, p.y)).filter((k) => k >= 0))
    const data = new Uint8Array(size.width * size.height)
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++)
        if (hit.has(frontAt(squares, (x + 0.5) / size.width, (y + 0.5) / size.height)))
          data[y * size.width + x] = 255
    return { width: size.width, height: size.height, data }
  }
  const toRgba = (bitmap: ImageBitmap, size: Size): RgbaImage => {
    const squares = world(timeOf(bitmap))
    const data = new Uint8ClampedArray(size.width * size.height * 4)
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        const k = frontAt(squares, (x + 0.5) / size.width, (y + 0.5) / size.height)
        // A textured static background, so camera motion is measured as none.
        const g = 100 + ((x * 7 + y * 13) % 31)
        const c = k >= 0 ? squares[k]!.color : ([g, g, g] as const)
        data.set([c[0], c[1], c[2], 255], (y * size.width + x) * 4)
      }
    return { width: size.width, height: size.height, data }
  }
  return { seg: seg as SegmentationBackend, prompts, toRgba }
}

const toGray = (_b: ImageBitmap, size: Size) => flatGray(size, 90)
const square = (x: number, color = RED): Square => ({ x, y: 0.4, size: 0.2, color })

function track(
  world: World,
  click: { t: number; points: Point[] },
  opts: { duration: number; colours?: boolean; corrections?: { t: number; points: Point[] }[] },
) {
  const { seg, prompts, toRgba } = fakeWorld(world)
  const { source } = fakeSource({ duration: opts.duration, width: 640, height: 360 })
  const deps: SelectionDeps = { segmentation: seg, toGray, ...(opts.colours ? { toRgba } : {}) }
  const run = buildSelectionTrack(deps, source, click, {
    fps: 10,
    maxSide: 160,
    ...(opts.corrections ? { corrections: opts.corrections } : {}),
  })
  return { run, prompts }
}

const isFound = (s: string) => s === 'tracking' || s === 'uncertain'
const centerAt = (res: SelectionTrackResult, i: number) => centroid(createTrackReader(res.track).frame(i))

describe('buildSelectionTrack', () => {
  it('follows a moving object forwards and backwards from the click', async () => {
    const at = (t: number) => square(0.2 + 0.1 * t)
    const { run, prompts } = track((t) => [at(t)], { t: 1, points: [{ x: 0.4, y: 0.5 }] }, { duration: 2 })
    const res = await run
    expect(res.track.meta).toMatchObject({
      kind: 'selection',
      fps: 10,
      start: 0,
      frameCount: 20,
      lostFrames: [],
    })
    expect(res.trackedFraction).toBe(1)
    expect(res.spans).toEqual([{ start: 0, end: 2, state: 'tracking' }])
    expect(res.needsCorrection).toEqual([])
    expect(prompts[0]).toEqual({ t: 1, points: [{ x: 0.4, y: 0.5 }] })
    const reader = createTrackReader(res.track)
    for (const t of [0, 0.5, 1.5, 1.9]) expect(centroid(reader.at(t))!.x).toBeCloseTo(at(t).x + 0.1, 1)
  })

  it('reports where the object was lost, holds its mask briefly and finds it again when it comes back', async () => {
    const hidden = (t: number) => t >= 1.05 && t < 2
    const { run } = track(
      (t) => (hidden(t) ? [] : [square(0.2)]),
      { t: 0.5, points: [{ x: 0.3, y: 0.5 }] },
      { duration: 3 },
    )
    const res = await run
    const lost = res.states.flatMap((s, i) => (s === 'lost' ? [i] : []))
    expect(lost).toEqual(Array.from({ length: 9 }, (_, k) => 11 + k))
    expect(res.states.slice(20).every(isFound)).toBe(true)
    expect(res.needsCorrection).toEqual([1.1])
    expect(selectionStateAt(res, 1.5)).toBe('lost')
    expect(selectionStateAt(res, 2.5)).toBe('tracking')
    const reader = createTrackReader(res.track)
    expect(coverage(reader.frame(11))).toBeGreaterThan(0)
    expect(coverage(reader.frame(15))).toBe(0)
    expect(centroid(reader.frame(25))!.x).toBeCloseTo(0.3, 1)
  })

  it('reports an object that leaves the picture as out of frame, not as lost', async () => {
    const { run } = track(
      (t) => [square(0.2 + 0.5 * t)],
      { t: 0.2, points: [{ x: 0.4, y: 0.5 }] },
      { duration: 2.5 },
    )
    const res = await run
    expect(res.states).not.toContain('lost')
    expect(res.states.at(-1)).toBe('out-of-frame')
    expect(coverage(createTrackReader(res.track).frame(res.states.length - 1))).toBe(0)
    expect(res.needsCorrection).toEqual([])
  })

  it('does not follow something else that passes in front of the object', async () => {
    const world: World = (t) => [square(0.3), square(0.9 - 0.5 * t, BLUE)]
    const click = { t: 0.2, points: [{ x: 0.4, y: 0.5 }] }
    const res = await track(world, click, { duration: 2.5, colours: true }).run
    const found = res.states.flatMap((s, i) => (isFound(s) ? [i] : []))
    expect(found.length).toBeGreaterThan(0)
    for (const i of found) expect(centerAt(res, i)!.x, `frame ${i}`).toBeGreaterThan(0.28)
    for (const i of found) expect(centerAt(res, i)!.x, `frame ${i}`).toBeLessThan(0.52)
    // Hidden while the blue square covers it, found again once it has passed.
    expect(res.states[13]).toBe('lost')
    expect(res.states.slice(20).every(isFound)).toBe(true)
  })

  it('re-anchors the track from a correction click where the object was lost', async () => {
    const world: World = (t) => [square(t < 1.5 ? 0.2 : 0.6)]
    const click = { t: 0.5, points: [{ x: 0.3, y: 0.5 }] }
    const plain = await track(world, click, { duration: 3 }).run
    expect(plain.states.slice(15).every((s) => s === 'lost')).toBe(true)
    expect(plain.needsCorrection).toEqual([1.5])

    const corrections = [{ t: 2.2, points: [{ x: 0.7, y: 0.5 }] }]
    const fixed = await track(world, click, { duration: 3, corrections }).run
    expect(fixed.states.every(isFound)).toBe(true)
    expect(fixed.needsCorrection).toEqual([])
    expect(centerAt(fixed, 10)!.x).toBeCloseTo(0.3, 1)
    for (const i of [15, 18, 22, 29]) expect(centerAt(fixed, i)!.x, `frame ${i}`).toBeCloseTo(0.7, 1)
  })

  it('rejects a click or a correction that selects nothing', async () => {
    const world: World = () => [square(0.2)]
    await expect(
      track(world, { t: 0.5, points: [{ x: 0.9, y: 0.9 }] }, { duration: 1 }).run,
    ).rejects.toMatchObject({ code: 'invalid-input' })
    const corrections = [{ t: 0.8, points: [{ x: 0.9, y: 0.9 }] }]
    await expect(
      track(world, { t: 0.2, points: [{ x: 0.3, y: 0.5 }] }, { duration: 1, corrections }).run,
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})
