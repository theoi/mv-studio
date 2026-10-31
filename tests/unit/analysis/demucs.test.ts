import { describe, expect, it } from 'vitest'
import {
  type DemucsModel,
  SEGMENT,
  segmentSpectrogram,
  separateStems,
} from '../../../src/analysis/stems/demucs.ts'

const RATE = 44100

function tone(seconds: number, phase = 0): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) =>
      0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE + phase) +
      0.2 * Math.sin((2 * Math.PI * 1375 * i) / RATE),
  )
}

/** Collects emitted chunks into full-length stems and records where each chunk started. */
async function run(model: DemucsModel, channels: Float32Array[], signal?: AbortSignal) {
  const n = channels[0]?.length ?? 0
  const stems = Array.from({ length: 4 }, () => [new Float32Array(n), new Float32Array(n)])
  const starts: number[] = []
  let progress = 0
  await separateStems(
    model,
    channels,
    (start, chunk) => {
      starts.push(start)
      chunk.forEach((pair, s) => pair.forEach((c, ch) => stems[s]?.[ch]?.set(c, start)))
    },
    { signal, onProgress: (f) => (progress = f) },
  )
  return { stems, starts, progress }
}

function maxError(a: Float32Array, b: Float32Array, scale: number): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number) * scale))
  return m
}

describe('separateStems', () => {
  it('inverts the spectrogram exactly through the frequency branch', async () => {
    // Each source gets a quarter of the input spectrogram, so each stem must come back as a quarter of the input.
    const model: DemucsModel = {
      async run(_mix, spec) {
        const x = new Float32Array(4 * spec.length)
        for (let s = 0; s < 4; s++)
          for (let i = 0; i < spec.length; i++) x[s * spec.length + i] = 0.25 * spec[i]
        return { x, xt: new Float32Array(4 * 2 * SEGMENT) }
      },
    }
    const left = tone(3)
    const right = tone(3, 1)
    const { stems } = await run(model, [left, right])
    for (const [left0, right0] of stems.map((p) => p as [Float32Array, Float32Array])) {
      expect(maxError(left0, left, 0.25)).toBeLessThan(1e-4)
      expect(maxError(right0, right, 0.25)).toBeLessThan(1e-4)
    }
  })

  it('overlap-adds segments into contiguous chunks covering the whole song', async () => {
    const model: DemucsModel = {
      async run(mix) {
        const xt = new Float32Array(4 * 2 * SEGMENT)
        for (let s = 0; s < 4; s++)
          for (let i = 0; i < 2 * SEGMENT; i++) xt[s * 2 * SEGMENT + i] = ((s + 1) / 10) * mix[i]
        return { x: new Float32Array(4 * 4 * 2048 * 336), xt }
      },
    }
    const left = tone(20)
    const { stems, starts, progress } = await run(model, [left])
    expect(starts).toEqual([0, 257985, 515970, 773955])
    expect(progress).toBe(1)
    stems.forEach((pair, s) => {
      expect(maxError(pair[0] as Float32Array, left, (s + 1) / 10)).toBeLessThan(1e-5)
      expect(maxError(pair[1] as Float32Array, left, (s + 1) / 10)).toBeLessThan(1e-5)
    })
  })

  it('stops between segments when cancelled', async () => {
    const controller = new AbortController()
    let calls = 0
    const model: DemucsModel = {
      async run() {
        calls++
        controller.abort(new Error('cancelled'))
        return { x: new Float32Array(4 * 4 * 2048 * 336), xt: new Float32Array(4 * 2 * SEGMENT) }
      },
    }
    await expect(run(model, [tone(20)], controller.signal)).rejects.toThrow('cancelled')
    expect(calls).toBe(1)
  })
})

describe('segmentSpectrogram', () => {
  it('writes every entry of a reused buffer, so nothing of the previous segment remains', () => {
    const mix = new Float32Array(2 * SEGMENT)
    mix.set(tone(SEGMENT / RATE))
    mix.set(tone(SEGMENT / RATE, 1), SEGMENT)
    const fresh = segmentSpectrogram(mix)
    const reused = segmentSpectrogram(mix, new Float32Array(fresh.length).fill(123.25))
    let differ = 0
    for (let i = 0; i < fresh.length; i++) if (reused[i] !== fresh[i]) differ++
    expect(differ).toBe(0)
  })
})
