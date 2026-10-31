import { describe, it, expect } from 'vitest'
import type { SubjectSample, SubjectTrack } from '../../../../src/vision/types.ts'
import {
  buildSubjectTrack,
  smoothSubjectTrack,
  subjectFromObservation,
  type FrameObservation,
} from '../../../../src/vision/reframe/track.ts'

const SIZE = { width: 1920, height: 1080 }

function obs(partial: Partial<FrameObservation> & { t?: number }): FrameObservation {
  return { t: 0, faces: [], personBox: null, personCoverage: 0, ...partial }
}

function sample(t: number, x: number, y = 0.5, source: SubjectSample['source'] = 'face'): SubjectSample {
  return source === 'none'
    ? { t, focus: { x: 0.5, y: 0.5 }, box: null, confidence: 0, source }
    : {
        t,
        focus: { x, y },
        box: { x: x - 0.05, y: y - 0.05, width: 0.1, height: 0.1 },
        confidence: 0.9,
        source,
      }
}

function track(samples: SubjectSample[]): SubjectTrack {
  return { version: 1, mediaId: 'm', sourceSize: SIZE, samples }
}

describe('subjectFromObservation', () => {
  const personBox = { x: 0.3, y: 0.2, width: 0.2, height: 0.6 }
  const face = { box: { x: 0.35, y: 0.22, width: 0.1, height: 0.1 }, score: 0.9 }

  it('prefers the selection box over faces and people', () => {
    const s = subjectFromObservation(
      obs({
        faces: [face],
        personBox,
        personCoverage: 0.1,
        selectionBox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
      }),
    )
    expect(s.source).toBe('selection')
    expect(s.focus.x).toBeCloseTo(0.7)
    expect(s.focus.y).toBeCloseTo(0.7)
  })

  it('uses confident faces, focusing on the largest score-weighted face, with a box spanning faces and person', () => {
    const big = { box: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 }, score: 0.6 } // weight 0.024
    const small = { box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, score: 0.95 } // weight 0.0095
    const s = subjectFromObservation(obs({ faces: [small, big], personBox, personCoverage: 0.1 }))
    expect(s.source).toBe('face')
    expect(s.focus.x).toBeCloseTo(0.8)
    expect(s.focus.y).toBeCloseTo(0.2)
    expect(s.confidence).toBeCloseTo(0.6)
    expect(s.box?.x).toBeCloseTo(0.1)
    expect(s.box?.y).toBeCloseTo(0.1)
    expect((s.box?.x ?? 0) + (s.box?.width ?? 0)).toBeCloseTo(0.9)
    expect((s.box?.y ?? 0) + (s.box?.height ?? 0)).toBeCloseTo(0.8)
  })

  it('ignores low-score faces and falls back to the person upper body', () => {
    const s = subjectFromObservation(
      obs({ faces: [{ ...face, score: 0.4 }], personBox, personCoverage: 0.05 }),
    )
    expect(s.source).toBe('person')
    expect(s.focus.x).toBeCloseTo(0.4)
    expect(s.focus.y).toBeCloseTo(0.2 + 0.22 * 0.6)
    expect(s.confidence).toBeCloseTo(0.5)
  })

  it('returns none for a person below the coverage threshold', () => {
    const s = subjectFromObservation(obs({ personBox, personCoverage: 0.004 }))
    expect(s).toMatchObject({ source: 'none', confidence: 0, box: null, focus: { x: 0.5, y: 0.5 } })
  })
})

describe('buildSubjectTrack', () => {
  it('orders samples by time', () => {
    const t = buildSubjectTrack('m', SIZE, [obs({ t: 1 }), obs({ t: 0 }), obs({ t: 0.5 })])
    expect(t.samples.map((s) => s.t)).toEqual([0, 0.5, 1])
  })
})

describe('smoothSubjectTrack', () => {
  const noBlur = { sigmaSeconds: 0 }

  it('holds the last focus for short gaps and eases toward the next observation for long ones', () => {
    const samples: SubjectSample[] = []
    for (let i = 0; i <= 40; i++) {
      const t = i / 10
      if (t <= 0.5) samples.push(sample(t, 0.3))
      else if (t < 3.5) samples.push(sample(t, 0, 0, 'none'))
      else samples.push(sample(t, 0.7))
    }
    const out = smoothSubjectTrack(track(samples), noBlur).samples
    const at = (t: number) => out.find((s) => Math.abs(s.t - t) < 1e-9)
    expect(at(1.4)?.focus.x).toBeCloseTo(0.3)
    // ease runs from 1.5 (0.3) to 3.5 (0.7)
    expect(at(2.5)?.focus.x).toBeCloseTo(0.5)
    expect(at(2.5)?.source).toBe('none')
    expect(at(2.5)?.box).not.toBeNull()
  })

  it('gives leading gaps the first known observation and keeps everything centred with no observation', () => {
    const lead = smoothSubjectTrack(
      track([sample(0, 0, 0, 'none'), sample(0.1, 0, 0, 'none'), sample(0.2, 0.8, 0.3)]),
      noBlur,
    )
    expect(lead.samples[0]?.focus.x).toBeCloseTo(0.8)
    expect(lead.samples[0]?.focus.y).toBeCloseTo(0.3)

    const empty = smoothSubjectTrack(track([0, 0.1, 0.2].map((t) => sample(t, 0, 0, 'none'))))
    for (const s of empty.samples) expect(s.focus).toEqual({ x: 0.5, y: 0.5 })
  })

  it('removes a single-frame outlier', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i / 30, i === 10 ? 0.95 : 0.4))
    const out = smoothSubjectTrack(track(samples), noBlur).samples
    expect(out[10]?.focus.x).toBeCloseTo(0.4)
    expect(out[10]?.confidence).toBeCloseTo(0.9)
  })

  it('reduces jitter variance with Gaussian smoothing on non-uniform timestamps', () => {
    let seed = 123456789
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const samples: SubjectSample[] = []
    let t = 0
    for (let i = 0; i < 150; i++) {
      samples.push(sample(t, 0.5 + (rand() - 0.5) * 0.06, 0.5 + (rand() - 0.5) * 0.06))
      t += 1 / 30 + rand() * 0.02
    }
    const variance = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
    }
    const before = variance(samples.map((s) => s.focus.x))
    const out = smoothSubjectTrack(track(samples))
    const after = variance(out.samples.map((s) => s.focus.x))
    expect(after).toBeLessThan(before * 0.25)
    const boxBefore = variance(samples.map((s) => s.box?.x ?? 0))
    const boxAfter = variance(out.samples.map((s) => s.box?.x ?? 0))
    expect(boxAfter).toBeLessThan(boxBefore * 0.25)
  })
})
