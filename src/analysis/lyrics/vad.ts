/** Where someone is singing, from the energy of a separated vocals stem. */
import { quantile } from '../dsp/stats.ts'

export interface TimeRange {
  start: number
  end: number
}

export interface VoiceActivityOptions {
  /** Frames this far below the stem's loud level count as silence (dB). */
  rangeDb?: number
  /** Shorter bursts are dropped (seconds). */
  minVoice?: number
  /** Shorter pauses are bridged (seconds). */
  minPause?: number
  /** Added before and after each region (seconds). */
  pad?: number
}

const FRAME_SECONDS = 0.02

/**
 * Sung regions of a vocals stem. Separation leaves the stem near silent between phrases, so a level threshold
 * relative to the loud parts of the stem is enough; it does not work on a full mix.
 */
export function voiceActivity(
  pcm: Float32Array,
  sampleRate: number,
  options: VoiceActivityOptions = {},
): TimeRange[] {
  const rangeDb = options.rangeDb ?? 30
  const minVoice = options.minVoice ?? 0.2
  const minPause = options.minPause ?? 0.6
  const pad = options.pad ?? 0.15
  const hop = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const frames = Math.floor(pcm.length / hop)
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += (pcm[i] as number) ** 2
    db[f] = 10 * Math.log10(sum / hop + 1e-12)
  }
  const audible = db.filter((v) => v > -80)
  if (audible.length === 0) return []
  const threshold = quantile(audible, 0.95) - rangeDb
  const fs = hop / sampleRate
  const raw: TimeRange[] = []
  let start = -1
  for (let f = 0; f <= frames; f++) {
    const on = f < frames && (db[f] as number) > threshold
    if (on && start < 0) start = f
    if (!on && start >= 0) {
      raw.push({ start: start * fs, end: f * fs })
      start = -1
    }
  }
  const merged: TimeRange[] = []
  for (const r of raw) {
    const last = merged.at(-1)
    if (last && r.start - last.end < minPause) last.end = r.end
    else merged.push({ ...r })
  }
  const duration = pcm.length / sampleRate
  return merged
    .filter((r) => r.end - r.start >= minVoice)
    .map((r) => ({ start: Math.max(0, r.start - pad), end: Math.min(duration, r.end + pad) }))
}

/**
 * Groups regions into chunks of at most `maxSeconds` (Whisper's window is 30 s), keeping pauses inside a chunk.
 * Regions longer than that are split evenly.
 */
export function planChunks(regions: readonly TimeRange[], maxSeconds = 28): TimeRange[] {
  const pieces = regions.flatMap((r) => {
    const n = Math.ceil((r.end - r.start) / maxSeconds)
    const len = (r.end - r.start) / n
    return Array.from({ length: n }, (_, k) => ({ start: r.start + k * len, end: r.start + (k + 1) * len }))
  })
  const chunks: TimeRange[] = []
  for (const p of pieces) {
    const last = chunks.at(-1)
    if (last && p.end - last.start <= maxSeconds) last.end = p.end
    else chunks.push({ ...p })
  }
  return chunks
}
