import { describe, expect, it } from 'vitest'
import { expectedShare, exportTimeLeft, type ExpectedTime } from '../../../src/engine/exportTime.ts'

const FRAMES = 5400

/** 14 min of frames whose first tenth (a quiet intro) takes 2% of the time, the rest evenly. */
const quietIntro: ExpectedTime = {
  seconds: 840,
  profile: Array.from({ length: 101 }, (_, k) => (k <= 10 ? 0.002 * k : 0.02 + (0.98 * (k - 10)) / 90)),
}

/** Reports the time left every 5 frames, as an export does, up to `until` of the frames; returns the last. */
function run(
  timeLeft: ReturnType<typeof exportTimeLeft>,
  elapsedAt: (share: number) => number,
  until: number,
): number | undefined {
  let left: number | undefined
  for (let done = 1; done <= until * FRAMES; done += 5) left = timeLeft(done, elapsedAt(done / FRAMES))
  return left
}

describe('the time left in an export', () => {
  it('starts from what its trial expected, so a quiet intro does not make the rest look quick', () => {
    const asExpected = (share: number) => quietIntro.seconds * expectedShare(quietIntro, share)
    const left = run(exportTimeLeft(FRAMES, quietIntro), asExpected, 0.03)!
    const truth = quietIntro.seconds - asExpected(0.03)
    expect(left).toBeGreaterThan(0.97 * truth)
    expect(left).toBeLessThan(1.03 * truth)
    // What the frames done so far would say on their own.
    expect((asExpected(0.03) * 0.97) / 0.03).toBeLessThan(truth / 4)
  })

  it("has moved to the export's own pace once a tenth of the frames are done", () => {
    const slower = (share: number) => 1.5 * quietIntro.seconds * expectedShare(quietIntro, share)
    const timeLeft = exportTimeLeft(FRAMES, quietIntro)
    const early = run(timeLeft, slower, 0.01)!
    expect(early).toBeLessThan(
      1.1 * (quietIntro.seconds - quietIntro.seconds * expectedShare(quietIntro, 0.01)),
    )
    const later = run(timeLeft, slower, 0.2)!
    const truth = slower(1) - slower(0.2)
    expect(later).toBeGreaterThan(0.97 * truth)
    expect(later).toBeLessThan(1.03 * truth)
  })

  it('says nothing without an expected time until a tenth of the frames are done, then follows its pace', () => {
    const timeLeft = exportTimeLeft(FRAMES)
    expect(timeLeft(0.05 * FRAMES, 15)).toBeUndefined()
    expect(timeLeft(0.2 * FRAMES, 60)).toBe(240)
  })

  it('eases up a rise in the time left instead of jumping', () => {
    const timeLeft = exportTimeLeft(FRAMES)
    expect(timeLeft(0.2 * FRAMES, 60)).toBe(240)
    // Its pace since the update at 20%, three times slower, now says 612 s.
    expect(timeLeft(0.32 * FRAMES, 168)).toBe(Math.round(240 + 0.2 * (612 - 240)))
  })

  it('follows the pace of the latest frames, so frames dearer than the trial expected count in full', () => {
    // As expected up to halfway, then 1.6 times slower.
    const half = expectedShare(quietIntro, 0.5)
    const elapsedAt = (share: number) => {
      const done = expectedShare(quietIntro, share)
      return quietIntro.seconds * (done <= half ? done : half + 1.6 * (done - half))
    }
    const left = run(exportTimeLeft(FRAMES, quietIntro), elapsedAt, 0.75)!
    const truth = elapsedAt(1) - elapsedAt(0.75)
    expect(left).toBeGreaterThan(0.97 * truth)
    expect(left).toBeLessThan(1.03 * truth)
  })

  it('moves no more for a one-off stall of a minute than for any other update', () => {
    const asExpected = (share: number) => quietIntro.seconds * expectedShare(quietIntro, share)
    const stalled = (share: number) => asExpected(share) + (share >= 0.5 ? 60 : 0)
    const timeLeft = exportTimeLeft(FRAMES, quietIntro)
    const ratios: number[] = []
    for (let done = 1; done <= 0.56 * FRAMES; done += 5) {
      const left = timeLeft(done, stalled(done / FRAMES))
      if (done / FRAMES >= 0.5 && left !== undefined)
        ratios.push(left / (stalled(1) - stalled(done / FRAMES)))
    }
    expect(ratios.length).toBeGreaterThan(50)
    expect(Math.max(...ratios)).toBeLessThan(1.03)
    expect(Math.min(...ratios)).toBeGreaterThan(0.97)
  })

  it('follows the pace of the latest frames without an expected time too', () => {
    // 0.1 s a frame up to halfway, then 0.2 s.
    const elapsedAt = (share: number) => (share <= 0.5 ? 540 * share : 270 + 1080 * (share - 0.5))
    const left = run(exportTimeLeft(FRAMES), elapsedAt, 0.75)!
    const truth = elapsedAt(1) - elapsedAt(0.75)
    expect(left).toBeGreaterThan(0.97 * truth)
    expect(left).toBeLessThan(1.03 * truth)
  })
})
