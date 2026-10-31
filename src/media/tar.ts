/**
 * Minimal ustar (tar) writer and reader over Blobs. Entries are composed as Blob parts, so OPFS-backed media files
 * are streamed by the browser when the result is saved and never copied into memory.
 */

export interface TarEntry {
  name: string
  data: Blob
}

const BLOCK = 512
const MAX_SIZE = 8 ** 11 - 1

function writeString(buf: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`)
  buf.set(bytes, offset)
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  writeString(buf, offset, length, value.toString(8).padStart(length - 1, '0'))
}

function splitName(name: string): { prefix: string; base: string } {
  if (new TextEncoder().encode(name).length <= 100) return { prefix: '', base: name }
  const cut = name.lastIndexOf('/', 155)
  if (cut <= 0 || name.length - cut - 1 > 100) throw new Error(`tar path too long: ${name}`)
  return { prefix: name.slice(0, cut), base: name.slice(cut + 1) }
}

function header(name: string, size: number, mtime: number): Uint8Array {
  if (size > MAX_SIZE) throw new Error(`tar entry too large: ${name}`)
  const h = new Uint8Array(BLOCK)
  const { prefix, base } = splitName(name)
  writeString(h, 0, 100, base)
  writeOctal(h, 100, 8, 0o644)
  writeOctal(h, 108, 8, 0)
  writeOctal(h, 116, 8, 0)
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, Math.floor(mtime / 1000))
  h.fill(0x20, 148, 156)
  h[156] = 0x30
  writeString(h, 257, 6, 'ustar')
  writeString(h, 263, 2, '00')
  writeString(h, 345, 155, prefix)
  let sum = 0
  for (const b of h) sum += b
  writeString(h, 148, 7, sum.toString(8).padStart(6, '0') + '\0')
  return h
}

export function writeTar(entries: TarEntry[], mtime = Date.now()): Blob {
  const parts: BlobPart[] = []
  for (const e of entries) {
    parts.push(header(e.name, e.data.size, mtime) as BlobPart, e.data)
    const pad = (BLOCK - (e.data.size % BLOCK)) % BLOCK
    if (pad) parts.push(new Uint8Array(pad) as BlobPart)
  }
  parts.push(new Uint8Array(BLOCK * 2) as BlobPart)
  return new Blob(parts, { type: 'application/x-tar' })
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice)
}

/** Lists entries; each entry's data is a lazy slice of the input blob. */
export async function readTar(blob: Blob): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK <= blob.size) {
    const h = new Uint8Array(await blob.slice(offset, offset + BLOCK).arrayBuffer())
    if (h.every((b) => b === 0)) break
    if (readString(h, 257, 5) !== 'ustar') throw new Error('Not a valid project file (bad tar header)')
    const base = readString(h, 0, 100)
    const prefix = readString(h, 345, 155)
    const size = parseInt(readString(h, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(h[156] ?? 0x30)
    const start = offset + BLOCK
    if (type === '0' || type === '\0')
      entries.push({ name: prefix ? `${prefix}/${base}` : base, data: blob.slice(start, start + size) })
    offset = start + Math.ceil(size / BLOCK) * BLOCK
  }
  return entries
}
