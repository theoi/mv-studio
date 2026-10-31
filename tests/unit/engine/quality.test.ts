import { describe, expect, it } from 'vitest'
import { AdaptiveScale, AUTO_SCALES } from '../../../src/engine/quality.ts'

/** Feeds frames for `ms` whose interval depends on the current scale (GPU-bound when it scales with pixel count). */
function run(auto: AdaptiveScale, from: number, ms: number, interval: (scale: number) => number): number {
  let now = from
  while (now < from + ms) {
    now += interval(auto.scale)
    auto.frame(now)
  }
  return now
}

describe('AdaptiveScale', () => {
  it('stays at full resolution while frames keep up with 60 fps', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    run(auto, 0, 10_000, () => 16.7)
    expect(auto.scale).toBe(1)
  })

  it('steps down until GPU-bound frames keep up, and only after half a second', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    const pixelBound = (s: number) => 45 * s * s
    run(auto, 0, 400, pixelBound)
    expect(auto.scale).toBe(1)
    run(auto, 400, 5_000, pixelBound)
    // 45 ms at full, 25 ms at 0.75 (still too slow), 11 ms at 0.5.
    expect(auto.scale).toBe(0.5)
  })

  it('goes down to the lowest level for a very slow machine', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    run(auto, 0, 20_000, (s) => 300 * s * s)
    expect(auto.scale).toBe(AUTO_SCALES[AUTO_SCALES.length - 1])
  })

  it('recovers full resolution after a few seconds of headroom', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    let now = run(auto, 0, 3_000, (s) => 45 * s * s)
    expect(auto.scale).toBeLessThan(1)
    now = run(auto, now, 2_000, () => 10)
    expect(auto.scale).toBeLessThan(1)
    run(auto, now, 10_000, () => 10)
    expect(auto.scale).toBe(1)
  })

  it('undoes a step down that does not speed frames up', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    let changes = 0
    let now = 0
    while (now < 10_000) {
      now += 40
      if (auto.frame(now)) changes++
    }
    expect(auto.scale).toBe(1)
    expect(changes).toBe(2)
  })

  it('stops stepping up when full resolution is too slow again right away', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    let changes = 0
    let now = 0
    // 30 ms at full resolution, 17 ms at 0.75: stepping up keeps failing.
    while (now < 30_000) {
      now += 30 * auto.scale * auto.scale
      if (auto.frame(now)) changes++
    }
    expect(auto.scale).toBe(0.75)
    expect(changes).toBe(3)
  })

  it('keeps its level for the next playback but ignores pauses between frames', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    run(auto, 0, 3_000, (s) => 45 * s * s)
    const level = auto.level
    auto.start(100_000)
    expect(auto.level).toBe(level)
    // A 1.5 s gap (hidden tab) between otherwise fast frames is not a slow frame.
    run(auto, 100_000, 600, () => 16)
    auto.frame(102_100)
    run(auto, 102_100, 600, () => 16)
    expect(auto.level).toBe(level)
  })
})
