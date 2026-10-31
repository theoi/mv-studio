export function mean(a: ArrayLike<number>, from = 0, to = a.length): number {
  if (to <= from) return 0
  let s = 0
  for (let i = from; i < to; i++) s += a[i]
  return s / (to - from)
}

export function std(a: ArrayLike<number>): number {
  const m = mean(a)
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2
  return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0
}

export function quantile(a: ArrayLike<number>, q: number): number {
  if (a.length === 0) return NaN
  const s = Float64Array.from(a).sort()
  const pos = Math.min(s.length - 1, Math.max(0, q * (s.length - 1)))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export function median(a: ArrayLike<number>): number {
  return quantile(a, 0.5)
}

/** Centered moving average with a window of 2*radius+1 samples (shrinks at edges). */
export function movingAverage(a: ArrayLike<number>, radius: number): Float64Array {
  const n = a.length
  const cs = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + a[i]
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius)
    const hi = Math.min(n, i + radius + 1)
    out[i] = (cs[hi] - cs[lo]) / (hi - lo)
  }
  return out
}

/** Centered moving maximum (window 2*radius+1). */
export function movingMax(a: ArrayLike<number>, radius: number): Float64Array {
  const n = a.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let m = -Infinity
    const lo = Math.max(0, i - radius)
    const hi = Math.min(n - 1, i + radius)
    for (let k = lo; k <= hi; k++) if (a[k] > m) m = a[k]
    out[i] = m
  }
  return out
}

/** Convolution with a symmetric kernel, output aligned to input ("same" mode, zero padded). */
export function convolveSame(a: ArrayLike<number>, kernel: ArrayLike<number>): Float64Array {
  const n = a.length
  const k = kernel.length
  const c = (k - 1) >> 1
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < k; j++) {
      const idx = i + j - c
      if (idx >= 0 && idx < n) s += a[idx] * kernel[j]
    }
    out[i] = s
  }
  return out
}

/** Throws the signal's reason if aborted; used between processing stages. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}
