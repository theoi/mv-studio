import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { centroid } from '../../../../src/vision/mask/ops.ts'
import { appendFrame, createPackedTrack, createTrackReader } from '../../../../src/vision/mask/track.ts'
import {
  buildPersonTrack,
  findTrackEvidence,
  trackSuitability,
} from '../../../../src/vision/segmentation/personTrack.ts'
import { checkSuitability } from '../../../../src/vision/segmentation/suitability.ts'
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

  it('looks for people 5 times a second, judges only the mask near them and keeps only that for the cutout', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const withPeople = await buildPersonTrack({ segmentation: fakeSegmentation() }, source, { faceFps: 0 })
    expect(withPeople.people.map((p) => p.t)).toEqual(
      [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8].map((t) => expect.closeTo(t, 6)),
    )
    // Each box keeps its score, so another limit can be tried on the stored track.
    expect(withPeople.people[0]).toEqual({
      t: 0,
      boxes: [{ x: 0, y: 0, width: 1, height: 1 }],
      scores: [0.9],
    })
    expect(withPeople.suitability.verdict).toBe('good')
    // The same masks with no one the detector calls a person: nothing is kept for the cutout.
    const noOne = await buildPersonTrack({ segmentation: fakeSegmentation(undefined, () => []) }, source, {
      faceFps: 0,
    })
    expect(withPeople.track.meta.coverage.every((c) => c > 0)).toBe(true)
    expect(noOne.track.meta.coverage.every((c) => c === 0)).toBe(true)
    expect(noOne.suitability).toMatchObject({ verdict: 'unsuitable', reasons: ['no-person-found'] })
  })

  it('says no person was found in a shot of an animal, as the quick check does, although the cutout keeps nothing of it', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    // The detector takes the cat for a person in 1 of its 5 detections a second; the animal vote rules it out.
    const cat = { box: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 }, score: 0.8 }
    const calledPerson = (t: number) => Math.round(t * 5) % 5 === 0
    const seg = () =>
      fakeSegmentation(undefined, (t) => (calledPerson(t) ? [cat] : []), {
        animalsAt: (t) => (calledPerson(t) ? [] : [cat]),
      })
    const res = await buildPersonTrack({ segmentation: seg() }, source, { faceFps: 0 })
    expect(res.people.some((p) => p.boxes.length)).toBe(true)
    expect(res.track.meta.coverage.every((c) => c === 0)).toBe(true)
    expect(res.suitability).toMatchObject({ verdict: 'unsuitable', reasons: ['no-person-found'] })
    expect((await checkSuitability(seg(), source)).reasons).toEqual(res.suitability.reasons)
  })
  /** A person in the middle and, apart from them, a patch the segmenter also cuts out. */
  const withPatch = (_t: number, s: { width: number; height: number }) => {
    const person = discMask(s, s.width / 2, s.height / 2, s.height / 4)
    const patch = discMask(s, s.width * 0.9, s.height * 0.2, s.height / 10)
    return { ...person, data: person.data.map((v, i) => Math.max(v, patch.data[i]!)) }
  }
  const middle = () => [{ box: { x: 0.35, y: 0.2, width: 0.3, height: 0.6 }, score: 0.9 }]

  it('keeps only the parts of the mask near the people found, and reframes on them', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const res = await buildPersonTrack({ segmentation: fakeSegmentation(withPatch, middle) }, source)
    const frame = createTrackReader(res.track).frame(10)
    const { width, height } = frame
    expect(frame.data[Math.round(height * 0.2) * width + Math.round(width * 0.9)]).toBe(0)
    expect(frame.data[Math.round(height / 2) * width + Math.round(width / 2)]).toBe(255)
    expect(res.observations).toHaveLength(10)
    for (const o of res.observations) expect(o.personBox!.x + o.personBox!.width).toBeLessThan(0.8)
  })

  it('keeps the whole mask when the person detector cannot be downloaded', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const res = await buildPersonTrack({ segmentation: fakeSegmentation(withPatch, () => null) }, source)
    const frame = createTrackReader(res.track).frame(10)
    const { width, height } = frame
    expect(frame.data[Math.round(height * 0.2) * width + Math.round(width * 0.9)]).toBe(255)
    for (const o of res.observations) expect(o.personBox!.x + o.personBox!.width).toBeGreaterThan(0.9)
  })

  it('cuts out without the detectors when they cannot be downloaded, judging the whole mask', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const seg = fakeSegmentation(undefined, () => null, { facesUnavailable: true })
    const res = await buildPersonTrack({ segmentation: seg }, source, { faceFps: 5 })
    expect(res.suitability).toMatchObject({ verdict: 'good', peopleSkipped: true })
    expect(res.people).toEqual([])
    expect(res.facesSkipped).toBe(true)
    // Observations keep the person box at the face rate, without faces.
    expect(res.observations).toHaveLength(10)
    expect(res.observations.every((o) => o.faces.length === 0 && o.personBox)).toBe(true)
    expect(seg.pushed).toHaveLength(50)
    expect(seg.pushed.filter((p) => p.people)).toHaveLength(1)
    expect(seg.pushed.filter((p) => p.faces)).toHaveLength(1)
  })

  /** A person whose mask drops out for 3 frames in every 12, as the segmenter sometimes does. */
  const dropouts = (t: number, s: { width: number; height: number }) =>
    discMask(s, s.width / 2, s.height / 2, Math.round(t * 25) % 12 < 3 ? 0 : s.height / 3)

  it('measures each frame’s pops through the temporal filter and calls a cutout that keeps popping unstable', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const popping = await buildPersonTrack({ segmentation: fakeSegmentation(dropouts) }, source, {
      faceFps: 0,
    })
    expect(popping.track.meta.pops).toHaveLength(50)
    expect(popping.suitability.stability!).toBeLessThan(0.9)
    expect(popping.suitability.reasons).toContain('unstable-mask')
    // A person who moves smoothly does not pop.
    const moving = await buildPersonTrack(
      {
        segmentation: fakeSegmentation((t, s) =>
          discMask(s, s.width * (0.3 + 0.2 * t), s.height / 2, s.height / 3),
        ),
      },
      source,
      { faceFps: 0 },
    )
    expect(moving.suitability).toMatchObject({ verdict: 'good', stability: 1 })
  })

  it('finds the people in a stored track without segmenting', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const built = await buildPersonTrack({ segmentation: fakeSegmentation() }, source, { faceFps: 0 })
    const seg = fakeSegmentation()
    const { people, pops } = await findTrackEvidence(seg, source, built.track, { people: true, pops: false })
    expect(people).toHaveLength(10)
    expect(people![0]!.boxes).toEqual([{ x: 0, y: 0, width: 1, height: 1 }])
    expect(pops).toBeUndefined()
    expect(seg.analyzed.every((a) => a.people && !a.mask && !a.gray)).toBe(true)
    expect(seg.calls).not.toContain('configure')
  })

  it('keeps the animals the detector finds with the people, when building a track and in a stored one', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const cat = { box: { x: 0.6, y: 0.5, width: 0.3, height: 0.4 }, score: 0.7 }
    const seg = () => fakeSegmentation(undefined, undefined, { animalsAt: () => [cat] })
    const built = await buildPersonTrack({ segmentation: seg() }, source, { faceFps: 0 })
    expect(built.people[0]).toMatchObject({ animals: [cat.box], animalScores: [0.7] })
    const { people } = await findTrackEvidence(seg(), source, built.track, { people: true, pops: false })
    expect(people![0]).toMatchObject({ animals: [cat.box], animalScores: [0.7] })
  })

  it('measures the pops of a stored track from every frame, as the build does', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const built = await buildPersonTrack({ segmentation: fakeSegmentation(dropouts) }, source, { faceFps: 0 })
    const { pops: stored, ...meta } = built.track.meta
    const seg = fakeSegmentation()
    const found = await findTrackEvidence(seg, source, { ...built.track, meta }, { people: true, pops: true })
    expect(found.pops).toEqual(stored)
    expect(found.people).toHaveLength(10)
    expect(seg.analyzed).toHaveLength(50)
    expect(seg.analyzed.every((a) => a.gray && !a.mask)).toBe(true)
  })

  it('stops looking for people in a stored track when the detector cannot be downloaded', async () => {
    const { source } = fakeSource({ duration: 2, frameRate: 25 })
    const built = await buildPersonTrack({ segmentation: fakeSegmentation() }, source, { faceFps: 0 })
    const seg = fakeSegmentation(undefined, () => null)
    expect(await findTrackEvidence(seg, source, built.track, { people: true, pops: false })).toEqual({
      peopleSkipped: true,
    })
    expect(seg.analyzed).toHaveLength(1)
    // With pops to measure, it still reads every frame, without asking for people again.
    const { pops: stored, ...meta } = built.track.meta
    const both = fakeSegmentation(undefined, () => null)
    const found = await findTrackEvidence(
      both,
      source,
      { ...built.track, meta },
      { people: true, pops: true },
    )
    expect(found).toEqual({ peopleSkipped: true, pops: stored })
    expect(both.analyzed).toHaveLength(50)
    expect(both.analyzed.filter((a) => a.people)).toHaveLength(1)
  })

  it('requires an ONNX backend for high-quality ranges', async () => {
    const { source } = fakeSource({ duration: 1 })
    await expect(
      buildPersonTrack({ segmentation: fakeSegmentation() }, source, { hqRanges: [{ start: 0, end: 1 }] }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('trackSuitability', () => {
  const meta = {
    version: 1 as const,
    kind: 'person' as const,
    mediaId: 'm',
    sourceSize: { width: 640, height: 360 },
    maskSize: { width: 64, height: 36 },
    fps: 25,
    start: 0,
    model: 'test',
    quality: 'standard' as const,
  }
  const rect = (x0: number, x1: number) => {
    const data = new Uint8Array(64 * 36)
    for (let y = 4; y < 36; y++) for (let x = x0; x < x1; x++) data[y * 64 + x] = 255
    return { width: 64, height: 36, data }
  }
  const track = () => {
    const t = createPackedTrack(meta)
    for (let k = 0; k < 50; k++) appendFrame(t, rect(20, 40), 0.3)
    return t
  }
  const hold = Array.from({ length: 10 }, (_, i) => ({
    t: i * 0.2,
    boxes: [{ x: 0, y: 0, width: 1, height: 1 }],
  }))

  it('judges stability from the pops stored with the track, or given for a track stored without them', () => {
    const stored = track()
    expect(trackSuitability(stored, hold).stability).toBeNull()
    stored.meta.pops = Array.from({ length: 50 }, (_, i) => (i % 4 ? 0 : 0.2))
    expect(trackSuitability(stored, hold)).toMatchObject({ stability: 0.74, reasons: ['unstable-mask'] })
    expect(trackSuitability(stored, hold, undefined, new Array<number>(50).fill(0))).toMatchObject({
      verdict: 'good',
      stability: 1,
    })
  })
})
