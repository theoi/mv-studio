import { describe, expect, it } from 'vitest'
import {
  cubicBezier,
  ease,
  evaluate,
  evaluateNumber,
  interpolate,
  sampleKeyframes,
} from '../../../src/engine/animation.ts'
import type { AudioSampler } from '../../../src/engine/audioFeatures.ts'
import type { Animatable, Keyframe } from '../../../src/model/types.ts'

describe('easing', () => {
  it('matches CSS cubic-bezier presets at known points', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3)
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 4)
    // CSS ease-in (0.42, 0, 1, 1) at t = 0.5 is about 0.3153
    expect(ease('ease-in', 0.5)).toBeCloseTo(0.3153, 3)
    expect(ease('ease-out', 0.5)).toBeCloseTo(1 - 0.3153, 3)
    expect(ease({ type: 'cubic-bezier', x1: 0, y1: 0, x2: 1, y2: 1 }, 0.42)).toBeCloseTo(0.42, 4)
  })

  it('is monotonic for overshoot-free curves and holds until the end', () => {
    const f = cubicBezier(0.42, 0, 0.58, 1)
    let prev = 0
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = f(Math.min(1, t))
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
    expect(ease('hold', 0.99)).toBe(0)
    expect(ease('hold', 1)).toBe(1)
  })
})

describe('keyframes', () => {
  const keys: Keyframe<number>[] = [
    { time: 1, value: 10, easing: 'linear' },
    { time: 3, value: 30, easing: 'hold' },
    { time: 5, value: 0, easing: 'linear' },
  ]

  it('clamps before the first and after the last keyframe', () => {
    expect(sampleKeyframes(keys, 0)).toBe(10)
    expect(sampleKeyframes(keys, 9)).toBe(0)
  })

  it('interpolates per segment using the left keyframe easing', () => {
    expect(sampleKeyframes(keys, 2)).toBeCloseTo(20)
    expect(sampleKeyframes(keys, 4.9)).toBe(30)
    expect(sampleKeyframes(keys, 5)).toBe(0)
  })

  it('interpolates tuples and hex colors, and steps other values', () => {
    expect(interpolate<[number, number]>([0, 10], [10, 20], 0.5)).toEqual([5, 15])
    expect(interpolate('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(interpolate('#ff000080', '#ff0000', 0.5)).toBe('#ff0000c0')
    expect(interpolate('left', 'right', 0.99)).toBe('left')
    expect(interpolate(true, false, 1)).toBe(false)
  })

  it('uses the static value when there are no keyframes', () => {
    expect(evaluate({ value: 7 }, 3)).toBe(7)
    expect(evaluate({ value: 7, keyframes: [] }, 3)).toBe(7)
  })
})

describe('audio modulation', () => {
  const sampler: AudioSampler = {
    sample: (source) => (source.kind === 'beat' ? 0.5 : 0.25),
    frame: () => ({
      loudness: 0,
      bands: [],
      onset: 0,
      beat: 0,
      downbeat: 0,
      beatIndex: 0,
      beatPhase: 0,
      barIndex: 0,
      barPhase: 0,
      flow: 0,
      stems: {},
    }),
    stem: () => sampler,
  }

  it('adds and multiplies feature values in order', () => {
    const anim: Animatable = {
      value: 1,
      modulation: [
        { source: { kind: 'beat' }, amount: 2, mode: 'add', smoothing: 0 },
        { source: { kind: 'loudness' }, amount: 4, mode: 'multiply', smoothing: 0 },
      ],
    }
    // (1 + 0.5 * 2) * (1 + 0.25 * 4) = 4
    expect(evaluateNumber(anim, 0, 0, sampler)).toBeCloseTo(4)
    expect(evaluateNumber(anim, 0, 0)).toBe(1)
  })
})
