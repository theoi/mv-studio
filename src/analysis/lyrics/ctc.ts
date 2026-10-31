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
 * Singing the tokens do not list (an unlisted intro or outro, ad-libs) at some blanks: a state of its own there,
 * entered for `entry` (log-probability) each time, that scores in each frame the better of the blank's
 * log-probability and the best token's minus `cost`.
 */
export interface Filler {
  /** Per blank (k: the blank before token k, tokens.length: after the last), nonzero where filler is allowed. */
  at: ArrayLike<number>
  cost: number
  entry: number
}

/**
 * Most likely CTC path that emits exactly `tokens` within frames [from, to): blanks are optional between tokens and
 * required between equal neighbours. `blankCost[k]` (log-probability per frame) is charged for every frame spent in
 * the blank before token k (k = tokens.length: after the last), and `tokenCost[t]` for a token emitted in frame t
 * (absolute). With `filler`, the path may also pass through unlisted singing at the blanks it allows. Returns one span
 * per token, or null when the frames cannot fit the tokens.
 */
export function forcedAlign(
  em: CtcEmissions,
  tokens: readonly number[],
  blank: number,
  from = 0,
  to = em.frames,
  blankCost?: ArrayLike<number>,
  tokenCost?: ArrayLike<number>,
  filler?: Filler,
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
  // Filler j sits at blank fK[j]: entered from the token before it or that blank, left to that blank or the next token.
  const fK: number[] = []
  for (let k = 0; filler && k <= L; k++) if (filler.at[k]) fK.push(k)
  const F = fK.length
  const fill = new Float64Array(F ? T : 0)
  for (let t = 0; t < fill.length; t++) {
    const row = (from + t) * V
    let best = -Infinity
    for (let v = 0; v < V; v++) if (v !== blank) best = Math.max(best, lp[row + v] as number)
    fill[t] = Math.max(lp[row + blank] as number, best - filler!.cost)
  }
  const entry = filler?.entry ?? 0
  // Per (frame, filler): 0 = stay, 1 = from the token before, 2 = from the blank.
  const fBack = new Uint8Array(T * F)
  let fPrev = new Float64Array(F).fill(-Infinity)
  let fCur = new Float64Array(F)
  // Two bits per (frame, state): 0 = stay, 1 = from s-1, 2 = from s-2, 3 = from the filler at that blank.
  const back = new Uint8Array(Math.ceil((T * S) / 4))
  let prev = new Float64Array(S).fill(-Infinity)
  let cur = new Float64Array(S)
  prev[0] = (lp[from * V + blank] as number) - costOf(0)
  prev[1] = (lp[from * V + (tokens[0] as number)] as number) - (tokenCost?.[from] ?? 0)
  for (let j = 0; j < F; j++) if (fK[j] === 0) fPrev[j] = (fill[0] as number) - entry
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
    for (let j = 0; j < F; j++) {
      const b = 2 * (fK[j] as number)
      let best = fPrev[j] as number
      let arg = 0
      if (b >= 1 && (prev[b - 1] as number) - entry > best) {
        best = (prev[b - 1] as number) - entry
        arg = 1
      }
      if ((prev[b] as number) - entry > best) {
        best = (prev[b] as number) - entry
        arg = 2
      }
      fCur[j] = best + (fill[t] as number)
      fBack[t * F + j] = arg
      // Leaving the filler, to its blank or the token after it.
      const out = fPrev[j] as number
      if (out === -Infinity) continue
      for (let s = b; s <= b + 1 && s < S; s++) {
        if (s < sMin || s > sMax) continue
        const v = out + (lp[row + tokenOf(s)] as number) - (s % 2 === 1 ? emitCost : costOf(s))
        if (v <= (cur[s] as number)) continue
        cur[s] = v
        const k = t * S + s
        back[k >> 2] |= 3 << ((k & 3) * 2)
      }
    }
    ;[prev, cur] = [cur, prev]
    ;[fPrev, fCur] = [fCur, fPrev]
  }
  let s = (prev[S - 1] as number) >= (prev[S - 2] as number) ? S - 1 : S - 2
  // In the filler after the last token (fK[F - 1] === L), or -1.
  let inF = F && fK[F - 1] === L && (fPrev[F - 1] as number) > (prev[s] as number) ? F - 1 : -1
  if (inF < 0 && prev[s] === -Infinity) return null
  const fOf = (b: number) => fK.indexOf(b >> 1)
  const spans: TokenSpan[] = Array.from({ length: L }, () => ({ start: -1, end: -1, score: 0 }))
  for (let t = T - 1; t >= 0; t--) {
    if (inF >= 0) {
      if (t === 0) break
      const code = fBack[t * F + inF]
      if (code === 0) continue
      s = 2 * (fK[inF] as number) - (code === 1 ? 1 : 0)
      inF = -1
      continue
    }
    if (s % 2 === 1) {
      const span = spans[(s - 1) >> 1] as TokenSpan
      if (span.end < 0) span.end = from + t + 1
      span.start = from + t
      span.score += Math.exp(lp[(from + t) * V + tokenOf(s)] as number)
    }
    if (t === 0) break
    const k = t * S + s
    const code = ((back[k >> 2] as number) >> ((k & 3) * 2)) & 3
    if (code === 3) inF = fOf(s % 2 === 1 ? s - 1 : s)
    else s -= code
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
