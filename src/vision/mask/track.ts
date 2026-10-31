import type { Mask, MaskSample, MaskTrackMeta, PackedMaskTrack } from '../types.ts'
import { decodeContainer, encodeContainer } from '../runtime/container.ts'
import { rleDecode, rleEncode } from './rle.ts'

/**
 * Mask tracks are stored packed (RLE per frame) so a 3-minute clip at 256 px stays around
 * 10–20 MB in memory, and any frame decodes synchronously for rendering.
 */
export function createPackedTrack(meta: Omit<MaskTrackMeta, 'frameCount' | 'coverage'>): PackedMaskTrack {
  return { meta: { ...meta, frameCount: 0, coverage: [] }, packed: [] }
}

export function appendFrame(track: PackedMaskTrack, mask: Mask, coverage: number): void {
  const { width, height } = track.meta.maskSize
  if (mask.width !== width || mask.height !== height)
    throw new Error('appendFrame: mask size differs from track')
  track.packed.push(rleEncode(mask.data))
  track.meta.coverage.push(coverage)
  track.meta.frameCount = track.packed.length
}

/** Frame indices and blend weight for media time `t` (clamped to the track). */
export function sampleAt(meta: MaskTrackMeta, t: number): MaskSample {
  if (meta.frameCount <= 1) return { i0: 0, i1: 0, weight: 0 }
  const f = (t - meta.start) * meta.fps
  if (f <= 0) return { i0: 0, i1: 0, weight: 0 }
  const last = meta.frameCount - 1
  if (f >= last) return { i0: last, i1: last, weight: 0 }
  const i0 = Math.floor(f)
  return { i0, i1: i0 + 1, weight: f - i0 }
}

export interface MaskTrackReader {
  readonly meta: MaskTrackMeta
  frame(index: number): Mask
  /** Blended mask at media time `t`. Deterministic, so preview and export agree. */
  at(t: number): Mask
}

export function createTrackReader(track: PackedMaskTrack, cacheSize = 6): MaskTrackReader {
  const { width, height } = track.meta.maskSize
  const cache = new Map<number, Mask>()
  const frame = (index: number): Mask => {
    const i = Math.min(track.packed.length - 1, Math.max(0, index))
    const hit = cache.get(i)
    if (hit) {
      cache.delete(i)
      cache.set(i, hit)
      return hit
    }
    const data = rleDecode(track.packed[i]!, width * height)
    const mask = { width, height, data }
    cache.set(i, mask)
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!)
    return mask
  }
  return {
    meta: track.meta,
    frame,
    at(t) {
      if (track.packed.length === 0) return { width, height, data: new Uint8Array(width * height) }
      const { i0, i1, weight } = sampleAt(track.meta, t)
      const a = frame(i0)
      if (weight === 0 || i0 === i1) return a
      const b = frame(i1)
      const out = new Uint8Array(a.data.length)
      const w = Math.round(weight * 256)
      for (let i = 0; i < out.length; i++) out[i] = (a.data[i]! * (256 - w) + b.data[i]! * w + 128) >> 8
      return { width, height, data: out }
    },
  }
}

export function serializeTrack(track: PackedMaskTrack): Promise<Uint8Array> {
  return encodeContainer(track.meta, track.packed)
}

export async function deserializeTrack(bytes: Uint8Array): Promise<PackedMaskTrack> {
  const { meta, chunks } = await decodeContainer<MaskTrackMeta>(bytes)
  if (meta.version !== 1 || chunks.length !== meta.frameCount)
    throw new Error('Unsupported or inconsistent mask track')
  return { meta, packed: chunks.map((c) => c.slice()) }
}
