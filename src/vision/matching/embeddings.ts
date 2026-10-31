import type { ClipVisionIndex } from '../types.ts'

/** Returns a new unit-length copy; a zero vector stays zero. */
export function normalize(v: Float32Array): Float32Array {
  let sq = 0
  for (let i = 0; i < v.length; i++) sq += v[i]! * v[i]!
  const out = new Float32Array(v.length)
  if (sq === 0) return out
  const inv = 1 / Math.sqrt(sq)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv
  return out
}

export function dot(
  a: Float32Array,
  b: Float32Array,
  aOffset = 0,
  bOffset = 0,
  dim: number = Math.min(a.length - aOffset, b.length - bOffset),
): number {
  let sum = 0
  for (let i = 0; i < dim; i++) sum += a[aOffset + i]! * b[bOffset + i]!
  return sum
}

/** Normalized mean of equally sized vectors; empty input gives an empty vector. */
export function meanVector(vectors: Float32Array[]): Float32Array {
  const first = vectors[0]
  if (!first) return new Float32Array(0)
  const acc = new Float32Array(first.length)
  for (const v of vectors) {
    if (v.length !== acc.length) throw new Error(`vector length mismatch: ${v.length} vs ${acc.length}`)
    for (let i = 0; i < acc.length; i++) acc[i]! += v[i]!
  }
  return normalize(acc)
}

/** View (no copy) of frame i's embedding. */
export function frameVector(index: ClipVisionIndex, i: number): Float32Array {
  return index.embeddings.subarray(i * index.dim, (i + 1) * index.dim)
}

/** Cosine similarity of q to every frame (frames are stored unit-length; q is normalized here). */
export function cosineToAll(index: ClipVisionIndex, q: Float32Array): Float32Array {
  const n = index.times.length
  const dim = index.dim
  const out = new Float32Array(n)
  if (q.length !== dim) throw new Error(`query dim ${q.length} does not match index dim ${dim}`)
  const qn = Math.sqrt(dot(q, q))
  if (qn === 0) return out
  const emb = index.embeddings
  for (let i = 0; i < n; i++) out[i] = dot(emb, q, i * dim, 0, dim) / qn
  return out
}
