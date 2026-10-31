/**
 * Latency-compensated timestamps. A take records what the user heard when they pressed, not when the press was
 * processed. The playback clock already reports the time of the sample leaving the speakers (output latency is
 * accounted for); this module rewinds that to the moment the input arrived, using the event's own timestamp, and
 * applies the user's calibrated input offset.
 */
import type { Seconds } from '../model/types.ts'

/** Older timestamps are treated as bogus (some platforms report 0 or a stale time) and ignored. */
export const MAX_INPUT_AGE: Seconds = 0.25

export interface InputClockReading {
  /** clock.currentTime() at `now`. */
  clockTime: Seconds
  playing: boolean
  /** performance.now() when the clock was read, in milliseconds. */
  now: number
  /** Event timestamp (KeyboardEvent.timeStamp, MIDIMessageEvent.timeStamp), in performance.now() milliseconds. */
  eventTime: number
  /** Calibrated input latency to subtract, in milliseconds. */
  offsetMs?: number
}

/** Timeline time the user heard when the input happened. While paused this is simply the clock time. */
export function inputTimelineTime(r: InputClockReading): Seconds {
  if (!r.playing) return r.clockTime
  const age = (r.now - r.eventTime) / 1000
  const delay = Number.isFinite(age) && age > 0 && age <= MAX_INPUT_AGE ? age : 0
  return Math.max(0, r.clockTime - delay - (r.offsetMs ?? 0) / 1000)
}

export interface InputOffsetEstimate {
  /** Median of tap minus beat, in milliseconds; positive when taps land late. */
  offsetMs: number
  /** Median absolute deviation of the taps around that offset, in milliseconds. */
  spreadMs: number
  /** Taps that counted (stray taps are left out). */
  used: number
}

const STRAY_MS = 60

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * Calibration: the user taps along to the beat; taps are already in heard timeline time (inputTimelineTime with no
 * offset). Returns null with fewer than four usable taps.
 */
export function estimateInputOffset(taps: Seconds[], beats: Seconds[]): InputOffsetEstimate | null {
  if (beats.length < 2) return null
  const sorted = [...beats].sort((a, b) => a - b)
  const errors: number[] = []
  for (const tap of taps) {
    let lo = 0
    let hi = sorted.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if ((sorted[mid] as number) <= tap) lo = mid
      else hi = mid
    }
    const a = sorted[lo] as number
    const b = sorted[hi] as number
    const nearest = Math.abs(tap - a) <= Math.abs(tap - b) ? a : b
    const interval = b - a || (sorted[1] as number) - (sorted[0] as number)
    const error = tap - nearest
    if (Math.abs(error) < interval / 2) errors.push(error * 1000)
  }
  if (errors.length < 4) return null
  // Drop stray taps (a missed beat, a double tap) far from the typical error, then measure again.
  const first = median(errors)
  const spread = median(errors.map((e) => Math.abs(e - first)))
  const kept = errors.filter((e) => Math.abs(e - first) <= Math.max(STRAY_MS, 3 * spread))
  if (kept.length < 4) return null
  const offsetMs = median(kept)
  return { offsetMs, spreadMs: median(kept.map((e) => Math.abs(e - offsetMs))), used: kept.length }
}
