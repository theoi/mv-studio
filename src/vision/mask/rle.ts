/**
 * PackBits-style run-length coding for 8-bit masks. Soft masks are mostly long runs of
 * 0 and 255 with short gradients at edges, so this is compact and decodes synchronously,
 * which lets the compositor fetch any frame of a cached track without async work.
 *
 * Header byte h: 0..127 → copy the next h+1 literal bytes; 128..255 → repeat the next
 * byte (h - 125) times (3..130).
 */
export function rleEncode(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length + Math.ceil(src.length / 128) + 2)
  let o = 0
  let i = 0
  const n = src.length
  while (i < n) {
    let run = 1
    while (i + run < n && run < 130 && src[i + run] === src[i]) run++
    if (run >= 3) {
      out[o++] = run + 125
      out[o++] = src[i]!
      i += run
      continue
    }
    const litStart = i
    let lit = 0
    while (i < n && lit < 128) {
      if (i + 2 < n && src[i] === src[i + 1] && src[i] === src[i + 2]) break
      i++
      lit++
    }
    out[o++] = lit - 1
    out.set(src.subarray(litStart, litStart + lit), o)
    o += lit
  }
  return out.slice(0, o)
}

export function rleDecode(
  src: Uint8Array,
  length: number,
  out: Uint8Array = new Uint8Array(length),
): Uint8Array {
  let i = 0
  let o = 0
  while (i < src.length && o < length) {
    const h = src[i++]!
    if (h < 128) {
      const count = Math.min(h + 1, length - o)
      out.set(src.subarray(i, i + count), o)
      i += h + 1
      o += count
    } else {
      const count = Math.min(h - 125, length - o)
      out.fill(src[i++]!, o, o + count)
      o += count
    }
  }
  if (o !== length) throw new Error(`RLE data decodes to ${o} bytes, expected ${length}`)
  return out
}
