import { describe, expect, it } from 'vitest'
import { createPopMeter, popGap } from '../../../../src/vision/mask/pops.ts'
import type { GrayImage, Mask } from '../../../../src/vision/types.ts'

const W = 64
const H = 36

/** A body (16 px wide) and an arm to its right, 8 px tall at row `armY`, or no arm. */
function figure(armY: number | null): Mask {
  const data = new Uint8Array(W * H)
  for (let y = 6; y < H; y++) for (let x = 24; x < 40; x++) data[y * W + x] = 255
  if (armY !== null) for (let y = armY; y < armY + 8; y++) for (let x = 40; x < 56; x++) data[y * W + x] = 255
  return { width: W, height: H, data }
}

/** Frame luma: the figure light on a dark background. */
const lumaOf = (m: Mask): GrayImage => ({ width: W, height: H, data: m.data.map((v) => (v ? 200 : 40)) })

function measure(fps: number, masks: Mask[], grays: GrayImage[]): number[] {
  const meter = createPopMeter(fps)
  const out: number[] = []
  masks.forEach((m, i) => {
    const share = meter.push(m, grays[i]!)
    if (share !== null) out.push(share)
  })
  return [...out, ...meter.flush()]
}

describe('pop meter', () => {
  it('looks about 0.125 s to each side', () => {
    expect([popGap(24), popGap(30), popGap(10), popGap(4)]).toEqual([3, 4, 1, 1])
  })

  it('finds an arm the mask drops for 2 frames while the picture keeps it, and nothing elsewhere', () => {
    const shown = figure(10)
    const masks = Array.from({ length: 20 }, (_, i) => (i === 8 || i === 9 ? figure(null) : shown))
    const pops = measure(
      24,
      masks,
      masks.map(() => lumaOf(shown)),
    )
    expect(pops).toHaveLength(20)
    // The arm is 128 of the 128 + 480 px figure, at half size 32 of 152.
    expect(pops[8]).toBeCloseTo(32 / 152, 2)
    expect(pops[9]).toBeCloseTo(32 / 152, 2)
    expect(pops.filter((p, i) => i !== 8 && i !== 9 && p > 0)).toEqual([])
  })

  it('does not count an arm that really swings up and back, which the picture shows too', () => {
    const masks = [10, 10, 10, 8, 4, 0, 4, 8, 10, 10, 10, 10].map((y) => figure(y))
    expect(measure(24, masks, masks.map(lumaOf)).every((p) => p === 0)).toBe(true)
    // The same mask changes over a picture that does not change are the mask's own.
    expect(
      Math.max(
        ...measure(
          24,
          masks,
          masks.map(() => lumaOf(figure(10))),
        ),
      ),
    ).toBeGreaterThan(0.05)
  })
})
