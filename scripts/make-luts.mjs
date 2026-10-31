#!/usr/bin/env node
// Writes the LUT images bundled with the app into public/luts/ (run: node scripts/make-luts.mjs).
// Layout ("strip"): a size-N cube is an N*N x N RGB image; pixel (x, y) holds the output color for input
// r = x mod N, g = y, b = floor(x / N), each scaled to 0..1 by N - 1.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

const SIZE = 32
const out = path.resolve(import.meta.dirname, '../public/luts')

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(width, height, rgb) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Renders a color transform (rgb in 0..1 -> rgb in 0..1) into a strip LUT image. */
function strip(transform) {
  const n = SIZE
  const rgb = Buffer.alloc(n * n * n * 3)
  for (let g = 0; g < n; g++)
    for (let b = 0; b < n; b++)
      for (let r = 0; r < n; r++) {
        const c = transform([r / (n - 1), g / (n - 1), b / (n - 1)])
        const i = (g * n * n + b * n + r) * 3
        for (let k = 0; k < 3; k++) rgb[i + k] = Math.round(Math.min(1, Math.max(0, c[k])) * 255)
      }
  return png(n * n, n, rgb)
}

const LUTS = {
  neutral: (c) => c,
}

mkdirSync(out, { recursive: true })
for (const [name, transform] of Object.entries(LUTS)) {
  writeFileSync(path.join(out, `${name}.png`), strip(transform))
  console.log(`public/luts/${name}.png`)
}
