import { describe, expect, it } from 'vitest'
import { AdaptiveScale, AUTO_SCALES, scrubScale } from '../../../src/engine/quality.ts'

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

  it('undoes a step down that does not speed frames up, and tries again later, less and less often', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    const stepsDown: number[] = []
    let full = 0
    let frames = 0
    let now = 0
    while (now < 30_000) {
      now += 40
      const level = auto.level
      if (auto.frame(now) && auto.level > level) stepsDown.push(now)
      frames++
      if (auto.scale === 1) full++
    }
    expect(auto.scale).toBe(1)
    // Tried at about 0.5 s, then 4 s and 8 s after each failed try.
    expect(stepsDown).toHaveLength(3)
    const [a, b, c] = stepsDown as [number, number, number]
    expect(b - a).toBeGreaterThan(4000)
    expect(c - b).toBeGreaterThan(8000)
    expect(full / frames).toBeGreaterThan(0.9)
  })

  it('judges a step down on frames drawn at the new scale, so slow frames keep stepping down', () => {
    // As measured at 2560 × 1440 on a software GPU: a fast first frame, then 140 ms at full size and 117 ms at 0.75.
    const intervals: Record<number, number> = { 1: 140, 0.75: 117, 0.5: 70, 0.33: 40 }
    const auto = new AdaptiveScale()
    auto.start(1000)
    let now = 1033
    auto.frame(1000)
    auto.frame(now)
    let left = false
    let back = false
    while (now < 7000) {
      now += intervals[auto.scale] as number
      auto.frame(now)
      if (auto.scale < 1) left = true
      else if (left) back = true
    }
    expect(left).toBe(true)
    expect(back).toBe(false)
    expect(auto.scale).toBeLessThanOrEqual(0.5)
  })

  it('tries a failed step down again, so one bad check does not keep full resolution for the whole playback', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    // For the first 2 s frames are slow whatever the scale (decoders warming up), then they depend on the pixels.
    const now = run(auto, 0, 2000, () => 120)
    expect(auto.scale).toBe(1)
    run(auto, now, 13_000, (s) => 120 * s * s)
    expect(auto.scale).toBeLessThan(1)
  })

  it('holds off stepping up after a step up is too slow right away, and tries again less and less often', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    const stepsUp: number[] = []
    let now = 0
    // 30 ms at full resolution, 17 ms at 0.75: every step up fails.
    while (now < 30_000) {
      now += 30 * auto.scale * auto.scale
      const level = auto.level
      if (auto.frame(now) && auto.level < level) stepsUp.push(now)
    }
    expect(auto.scale).toBe(0.75)
    // After 3 s of headroom, then at least 4 s and 8 s after each failed try.
    expect(stepsUp).toHaveLength(3)
    const [a, b, c] = stepsUp as [number, number, number]
    expect(b - a).toBeGreaterThan(4000)
    expect(c - b).toBeGreaterThan(8000)
  })

  it('recovers full resolution after a heavy stretch, even when a step up failed in it', () => {
    const auto = new AdaptiveScale()
    auto.start(0)
    // A heavy section (30 ms at full resolution, 17 ms at 0.75) where stepping up fails, then a light one.
    const now = run(auto, 0, 6_000, (s) => 30 * s * s)
    expect(auto.scale).toBe(0.75)
    run(auto, now, 20_000, () => 10)
    expect(auto.scale).toBe(1)
  })

  it('keeps a step down that raises the frame rate although most intervals stay the same (60 Hz steps)', () => {
    // About 30 ms per frame at full size and 18 ms at 0.75. On a 60 Hz display full size shows a frame every 33.3 ms,
    // and at 0.75 two of every three frames still take 33.3 ms: 36 fps instead of 30.
    const auto = new AdaptiveScale()
    auto.start(0)
    let now = 0
    let n = 0
    let left = false
    let back = false
    while (now < 10_000) {
      if (auto.scale === 1) now += 33.3
      else if (auto.scale === 0.75) now += n++ % 3 === 2 ? 16.7 : 33.3
      else now += 16.7
      auto.frame(now)
      if (auto.scale < 1) left = true
      else if (left) back = true
    }
    expect(left).toBe(true)
    expect(back).toBe(false)
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

describe('scrubScale', () => {
  it('keeps full size while a full-size still fits in a frame, else the largest step that would', () => {
    expect(scrubScale(10)).toBe(1)
    // 30 ms at 0.75 (56 % of the pixels) would still take 17 ms.
    expect(scrubScale(30)).toBe(0.5)
    expect(scrubScale(75)).toBe(0.33)
    expect(scrubScale(500)).toBe(AUTO_SCALES[AUTO_SCALES.length - 1])
  })
})
