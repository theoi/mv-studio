import { describe, expect, it } from 'vitest'
import { part } from '../../../src/analysis/jobContext.ts'
import { lyricsSeconds } from '../../../src/analysis/lyrics/client.ts'
import {
  deviceSlowdown,
  separateSecondsPerSecond,
  stemJobSeconds,
} from '../../../src/analysis/stems/device.ts'
import type { JobProgress } from '../../../src/shared/jobs.ts'

/*
 * Wall times measured on a 4-core machine without a GPU (so 3 WASM threads), on held-out songs the estimates were
 * not fitted to: an estimate must not promise less than that, nor much more.
 */
describe('stem separation estimate', () => {
  it('covers whole-app runs from Separate to Ready, within 15%', () => {
    const runs = [
      { song: 176, wall: 288 },
      { song: 251, wall: 397 },
      { song: 312, wall: 494 },
    ]
    for (const { song, wall } of runs) {
      const estimate = stemJobSeconds(song, 'wasm', 3)
      expect(estimate, `${song} s song`).toBeGreaterThanOrEqual(wall)
      expect(estimate, `${song} s song`).toBeLessThanOrEqual(wall * 1.15)
    }
  })

  it("fits a faster machine's own wall time once it has measured its pace", () => {
    // A 4-core machine whose separation stage ran at 1.09 s per second of song: Separate to Ready took 348 s for a
    // 5:03 song, which the defaults put at 509 s.
    const pace = { secondsPerSecond: 1.09, device: 'wasm' as const, threads: 3 }
    expect(stemJobSeconds(303, 'wasm', 3)).toBeGreaterThan(348 * 1.4)
    expect(stemJobSeconds(303, 'wasm', 3, pace)).toBeGreaterThanOrEqual(348)
    expect(stemJobSeconds(303, 'wasm', 3, pace)).toBeLessThanOrEqual(348 * 1.15)
    // The pace was measured with 3 threads; with 1 the same machine is slower, and a GPU run ignores it.
    expect(separateSecondsPerSecond('wasm', 1, pace)).toBeGreaterThan(2 * 1.09)
    expect(separateSecondsPerSecond('webgpu', 3, pace)).toBe(separateSecondsPerSecond('webgpu', 3))
    // One odd run cannot make estimates absurd.
    expect(deviceSlowdown('wasm', { ...pace, secondsPerSecond: 100 })).toBe(4)
    expect(deviceSlowdown('wasm', { ...pace, secondsPerSecond: 0 })).toBe(1)
  })

  it('gets faster with more threads and on a GPU', () => {
    const rates = [1, 2, 3, 4, 8].map((threads) => separateSecondsPerSecond('wasm', threads))
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1] as number)
    expect(separateSecondsPerSecond('webgpu', 3)).toBeLessThan(rates[2] as number)
  })
})

describe('lyrics estimate, vocals already separated', () => {
  it('covers timing pasted lyrics, within 15% (alignment took 55 s on a 2:56 song and 98 s on a 5:24 one)', () => {
    for (const { song, wall } of [
      { song: 176, wall: 55 },
      { song: 324, wall: 98 },
    ]) {
      expect(lyricsSeconds(song, 'time')).toBeGreaterThanOrEqual(wall)
      expect(lyricsSeconds(song, 'time')).toBeLessThanOrEqual(wall * 1.15)
    }
  })

  it('scales with how fast this device separated stems', () => {
    expect(lyricsSeconds(176, 'time', 0.7)).toBeLessThan(lyricsSeconds(176, 'time'))
    expect(lyricsSeconds(176, 'time', 1.3)).toBeGreaterThan(lyricsSeconds(176, 'time'))
  })

  it('covers drafting without overstating it by more than 30% (142 to 148 s for 3:19 to 4:11 songs)', () => {
    for (const song of [199, 251]) {
      expect(lyricsSeconds(song, 'draft')).toBeGreaterThanOrEqual(148)
      expect(lyricsSeconds(song, 'draft')).toBeLessThanOrEqual(142 * 1.35)
    }
  })
})

describe('time left in a job made of parts', () => {
  it("adds the later steps' time to a part's remaining time and maps its fraction", () => {
    const seen: JobProgress[] = []
    const ctx = {
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
      progress: (p: JobProgress) => seen.push(p),
    }
    const stems = part(ctx, 0, 0.8, 60)
    stems.progress({ fraction: 0.5, etaSeconds: 100, stage: 'separate' })
    stems.progress({ stage: 'encode' })
    expect(seen).toEqual([{ fraction: 0.4, etaSeconds: 160, stage: 'separate' }, { stage: 'encode' }])
  })
})
