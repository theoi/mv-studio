import { JobError } from '../../shared/jobs.ts'

/**
 * Binary container for cached vision results: JSON metadata plus raw chunks.
 * Layout (little endian): "MVV1" | u32 flags | u32 metaBytes | meta JSON | u32 chunkCount
 * | u32 chunkBytes[chunkCount] | chunk payload (optionally deflate-raw compressed).
 */
const MAGIC = 0x3156564d // "MVV1"
const FLAG_DEFLATE = 1

export interface Container<M> {
  meta: M
  chunks: Uint8Array[]
}

export async function encodeContainer<M>(
  meta: M,
  chunks: Uint8Array[],
  options: { compress?: boolean } = {},
): Promise<Uint8Array> {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  let payload = concat(chunks)
  const flags = options.compress ? FLAG_DEFLATE : 0
  if (options.compress) payload = await transform(payload, new CompressionStream('deflate-raw'))
  const headerBytes = 4 * 4 + metaBytes.length + 4 * chunks.length
  const out = new Uint8Array(headerBytes + payload.length)
  const view = new DataView(out.buffer)
  let o = 0
  view.setUint32(o, MAGIC, true)
  view.setUint32((o += 4), flags, true)
  view.setUint32((o += 4), metaBytes.length, true)
  out.set(metaBytes, (o += 4))
  o += metaBytes.length
  view.setUint32(o, chunks.length, true)
  o += 4
  for (const c of chunks) {
    view.setUint32(o, c.length, true)
    o += 4
  }
  out.set(payload, o)
  return out
}

export async function decodeContainer<M>(bytes: Uint8Array): Promise<Container<M>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (why: string) => new JobError('internal', `Corrupt vision cache entry: ${why}`)
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== MAGIC) throw fail('bad header')
  const flags = view.getUint32(4, true)
  const metaLen = view.getUint32(8, true)
  let o = 12
  if (o + metaLen + 4 > bytes.byteLength) throw fail('truncated metadata')
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + metaLen))) as M
  o += metaLen
  const count = view.getUint32(o, true)
  o += 4
  if (o + count * 4 > bytes.byteLength) throw fail('truncated chunk table')
  const lengths: number[] = []
  for (let i = 0; i < count; i++, o += 4) lengths.push(view.getUint32(o, true))
  let payload = bytes.subarray(o)
  if (flags & FLAG_DEFLATE) payload = await transform(payload, new DecompressionStream('deflate-raw'))
  const total = lengths.reduce((a, b) => a + b, 0)
  if (payload.length < total) throw fail('truncated payload')
  const chunks: Uint8Array[] = []
  let p = 0
  for (const len of lengths) {
    chunks.push(payload.subarray(p, p + len))
    p += len
  }
  return { meta, chunks }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const blob = new Blob([data as unknown as ArrayBuffer])
  const result = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer()
  return new Uint8Array(result)
}
