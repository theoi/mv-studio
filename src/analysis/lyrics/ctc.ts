/** CTC emissions and Viterbi forced alignment (the CTC topology used by torchaudio's forced_align). */

export interface CtcEmissions {
  /** Log-probabilities, frame-major: frames x vocab. */
  logProbs: Float32Array
  frames: number
  vocab: number
  /** Seconds per frame. */
  frameSeconds: number
}

/** Frames [start, end) where a token is emitted, and its mean posterior there. */
export interface TokenSpan {
  start: number
  end: number
  score: number
}

/**
 * Most likely CTC path that emits exactly `tokens` within frames [from, to): blanks are optional between tokens and
 * required between equal neighbours. `blankCost[k]` (log-probability per frame) is charged for every frame spent in
 * the blank before token k (k = tokens.length: after the last), and `tokenCost[t]` for a token emitted in frame t
 * (absolute). Returns one span per token, or null when the frames cannot fit the tokens.
 */
export function forcedAlign(
  em: CtcEmissions,
  tokens: readonly number[],
  blank: number,
  from = 0,
  to = em.frames,
  blankCost?: ArrayLike<number>,
  tokenCost?: ArrayLike<number>,
): TokenSpan[] | null {
  const L = tokens.length
  const T = to - from
  if (L === 0) return []
  let needed = L
  for (let i = 1; i < L; i++) if (tokens[i] === tokens[i - 1]) needed++
  if (T < needed) return null
  const S = 2 * L + 1
  const V = em.vocab
  const lp = em.logProbs
  const tokenOf = (s: number) => (s % 2 === 1 ? (tokens[(s - 1) >> 1] as number) : blank)
  const costOf = (s: number) => (s % 2 === 0 ? (blankCost?.[s >> 1] ?? 0) : 0)
  // Two bits per (frame, state): 0 = stay, 1 = from s-1, 2 = from s-2.
  const back = new Uint8Array(Math.ceil((T * S) / 4))
  let prev = new Float64Array(S).fill(-Infinity)
  let cur = new Float64Array(S)
  prev[0] = (lp[from * V + blank] as number) - costOf(0)
  prev[1] = (lp[from * V + (tokens[0] as number)] as number) - (tokenCost?.[from] ?? 0)
  for (let t = 1; t < T; t++) {
    const row = (from + t) * V
    const emitCost = tokenCost?.[from + t] ?? 0
    // States that cannot be reached yet, or can no longer finish in time, stay at -Infinity.
    const sMin = Math.max(0, S - 2 * (T - t))
    const sMax = Math.min(S - 1, 2 * t + 1)
    cur.fill(-Infinity)
    for (let s = sMin; s <= sMax; s++) {
      let best = prev[s] as number
      let arg = 0
      if (s >= 1 && (prev[s - 1] as number) > best) {
        best = prev[s - 1] as number
        arg = 1
      }
      if (s >= 2 && s % 2 === 1 && tokenOf(s) !== tokenOf(s - 2) && (prev[s - 2] as number) > best) {
        best = prev[s - 2] as number
        arg = 2
      }
      if (best === -Infinity) continue
      cur[s] = best + (lp[row + tokenOf(s)] as number) - (s % 2 === 1 ? emitCost : costOf(s))
      const k = t * S + s
      back[k >> 2] |= arg << ((k & 3) * 2)
    }
    ;[prev, cur] = [cur, prev]
  }
  let s = (prev[S - 1] as number) >= (prev[S - 2] as number) ? S - 1 : S - 2
  if (prev[s] === -Infinity) return null
  const spans: TokenSpan[] = Array.from({ length: L }, () => ({ start: -1, end: -1, score: 0 }))
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const span = spans[(s - 1) >> 1] as TokenSpan
      if (span.end < 0) span.end = from + t + 1
      span.start = from + t
      span.score += Math.exp(lp[(from + t) * V + tokenOf(s)] as number)
    }
    if (t === 0) break
    const k = t * S + s
    s -= ((back[k >> 2] as number) >> ((k & 3) * 2)) & 3
  }
  for (const span of spans) span.score /= span.end - span.start
  return spans
}

/** Log-softmax of frame-major logits, in place. */
export function logSoftmaxRows(logits: Float32Array, vocab: number): Float32Array {
  for (let o = 0; o < logits.length; o += vocab) {
    let max = -Infinity
    for (let k = 0; k < vocab; k++) max = Math.max(max, logits[o + k] as number)
    let sum = 0
    for (let k = 0; k < vocab; k++) sum += Math.exp((logits[o + k] as number) - max)
    const lse = max + Math.log(sum)
    for (let k = 0; k < vocab; k++) logits[o + k] = (logits[o + k] as number) - lse
  }
  return logits
}
