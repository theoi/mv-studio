/** Deterministic synthetic music for analysis tests. */
export const SR = 22050

export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

export interface DrumOptions {
  bpm: number
  seconds: number
  /** Seconds before the first beat. */
  offset?: number
  seed?: number
  /** Tempo changes as [timeSec, bpm] pairs, applied in order. */
  tempoChanges?: [number, number][]
  gain?: number
}

/** Kick on 1 and 3, snare on 2 and 4, hi-hat on eighths. Returns audio and the true beat times. */
export function drumLoop(opts: DrumOptions): { audio: Float32Array; beats: number[]; downbeats: number[] } {
  const n = Math.round(opts.seconds * SR)
  const audio = new Float32Array(n)
  const rand = rng(opts.seed ?? 1)
  const gain = opts.gain ?? 1
  const beats: number[] = []
  const downbeats: number[] = []
  let t = opts.offset ?? 0.5
  let bpm = opts.bpm
  let i = 0
  const changes = [...(opts.tempoChanges ?? [])]
  const add = (start: number, fn: (k: number) => number, len: number) => {
    const s0 = Math.round(start * SR)
    for (let k = 0; k < len && s0 + k < n; k++) audio[s0 + k] += gain * fn(k)
  }
  while (t < opts.seconds - 0.1) {
    const change = changes[0]
    if (change && t >= change[0]) {
      bpm = change[1]
      changes.shift()
    }
    const period = 60 / bpm
    beats.push(t)
    if (i % 4 === 0) downbeats.push(t)
    const pos = i % 4
    if (pos === 0 || pos === 2)
      add(
        t,
        (k) => 0.9 * Math.sin((2 * Math.PI * (55 + 60 * Math.exp(-k / 400)) * k) / SR) * Math.exp(-k / 2500),
        8000,
      )
    if (pos === 1 || pos === 3)
      add(
        t,
        (k) =>
          0.5 * rand() * Math.exp(-k / 1500) +
          0.3 * Math.sin((2 * Math.PI * 190 * k) / SR) * Math.exp(-k / 1200),
        5000,
      )
    for (const h of [0, 0.5]) add(t + h * period, () => 0.12 * rand() * Math.exp(-1 / 300), 1500)
    t += period
    i++
  }
  return { audio, beats, downbeats }
}

const NOTE = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

/** Sustained chord pad playing one chord per bar. */
export function chordPad(
  chords: number[][],
  bpm: number,
  seconds: number,
  offset: number,
  gain = 0.15,
): Float32Array {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const bar = (4 * 60) / bpm
  for (let s = 0; s < n; s++) {
    const t = s / SR - offset
    if (t < 0) continue
    const chord = chords[Math.floor(t / bar) % chords.length] as number[]
    let v = 0
    for (const m of chord) v += Math.sin(2 * Math.PI * NOTE(m) * (s / SR))
    out[s] = (gain * v) / chord.length
  }
  return out
}

export function sine(hz: number, seconds: number, amplitude = 0.5, rate = SR): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  )
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function mix(...tracks: Float32Array[]): Float32Array {
  const n = Math.max(...tracks.map((t) => t.length))
  const out = new Float32Array(n)
  for (const t of tracks) for (let i = 0; i < t.length; i++) out[i] += t[i] as number
  return out
}

/** Beat-tracking F-measure with a ±70 ms window. */
export function fmeasure(est: number[], ref: number[], tol = 0.07): number {
  const used = new Uint8Array(ref.length)
  let hit = 0
  for (const e of est) {
    for (let k = 0; k < ref.length; k++) {
      if (!used[k] && Math.abs((ref[k] as number) - e) <= tol) {
        used[k] = 1
        hit++
        break
      }
    }
  }
  const p = hit / Math.max(1, est.length)
  const r = hit / Math.max(1, ref.length)
  return p + r ? (2 * p * r) / (p + r) : 0
}
