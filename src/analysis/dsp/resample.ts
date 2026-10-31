/**
 * Deterministic windowed-sinc (Kaiser) resampling. Web Audio's OfflineAudioContext is not
 * available in workers, and a fixed JS implementation keeps analysis results reproducible.
 */

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-16) break
  }
  return sum
}

const MAX_EXACT_PHASES = 4096

interface Kernel {
  phases: number
  taps: number
  half: number
  table: Float32Array
}

const kernelCache = new Map<string, Kernel>()

function buildKernel(phases: number, cutoff: number, zeroCrossings: number, beta: number): Kernel {
  const key = `${phases}:${cutoff}:${zeroCrossings}:${beta}`
  const cached = kernelCache.get(key)
  if (cached) return cached
  // cutoff is in cycles per input sample (0.5 = input Nyquist).
  const width = zeroCrossings / (2 * cutoff)
  const half = Math.ceil(width)
  const taps = 2 * half
  const table = new Float32Array(phases * taps)
  const i0Beta = besselI0(beta)
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const offset = j - half + 1
      const t = frac - offset
      const u = t / width
      let v = 0
      if (Math.abs(u) <= 1) {
        const x = 2 * cutoff * t
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
        v = 2 * cutoff * sinc * (besselI0(beta * Math.sqrt(1 - u * u)) / i0Beta)
      }
      table[p * taps + j] = v
      sum += v
    }
    // Normalize each phase to unity DC gain so constant signals stay constant.
    if (sum !== 0) for (let j = 0; j < taps; j++) table[p * taps + j] /= sum
  }
  const kernel = { phases, taps, half, table }
  kernelCache.set(key, kernel)
  return kernel
}

export interface ResampleOptions {
  /** Passband edge as a fraction of the lower Nyquist frequency. */
  rolloff?: number
  zeroCrossings?: number
  beta?: number
}

export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  options: ResampleOptions = {},
): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('Sample rates must be positive')
  const from = Math.round(fromRate)
  const to = Math.round(toRate)
  if (from === to) return input.slice()
  const g = gcd(from, to)
  const up = to / g
  const down = from / g
  const rolloff = options.rolloff ?? 0.94
  const cutoff = 0.5 * Math.min(1, to / from) * rolloff
  const phases = up <= MAX_EXACT_PHASES ? up : MAX_EXACT_PHASES
  const kernel = buildKernel(phases, cutoff, options.zeroCrossings ?? 12, options.beta ?? 8.5)
  const { taps, half, table } = kernel
  const n = input.length
  const outLength = n === 0 ? 0 : Math.ceil((n * up) / down)
  const out = new Float32Array(outLength)
  const exact = phases === up
  for (let i = 0; i < outLength; i++) {
    const num = i * down
    const base = Math.floor(num / up)
    const rem = num - base * up
    const phase = exact ? rem : Math.min(phases - 1, Math.round((rem / up) * phases))
    const row = phase * taps
    const start = base - half + 1
    let acc = 0
    if (start >= 0 && start + taps <= n) {
      for (let j = 0; j < taps; j++) acc += input[start + j] * table[row + j]
    } else {
      for (let j = 0; j < taps; j++) {
        const k = start + j
        if (k >= 0 && k < n) acc += input[k] * table[row + j]
      }
    }
    out[i] = acc
  }
  return out
}

/** Average all channels into one. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0].slice()
  const n = Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(n)
  const scale = 1 / channels.length
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * scale
  return out
}
