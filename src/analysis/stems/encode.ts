import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  OggOutputFormat,
  Output,
  QUALITY_HIGH,
  WavOutputFormat,
} from 'mediabunny'
import { createStreamResampler, type StreamResampler } from '../dsp/resample.ts'

export type StemCodec = 'opus' | 'pcm-s16'

export interface EncodedAudio {
  data: ArrayBuffer
  mimeType: string
  extension: string
}

export interface StemEncoder {
  /** Appends stereo audio starting at sample `start`; calls must be in order and contiguous. */
  add(start: number, left: Float32Array, right: Float32Array): Promise<void>
  finish(): Promise<EncodedAudio>
}

/** Opus always codes 48 kHz audio. */
const OPUS_RATE = 48_000

/** Opus in Ogg (about 5 MB per stem for a 4-minute song) when the browser can encode it, else 16-bit WAV. */
export async function pickStemCodec(): Promise<StemCodec> {
  try {
    if (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: OPUS_RATE })) return 'opus'
  } catch {
    // No WebCodecs encoder (e.g. outside a browser): fall through to PCM.
  }
  return 'pcm-s16'
}

/**
 * Encodes a stem that must stay sample-aligned with the song: decoded, it starts at the same instant and has the same
 * length. Opus input is resampled to 48 kHz here, because the browser's encoder resamples other rates with a delay of
 * its own (about 32 samples at 44.1 kHz) and drops the last partial frame. It is stored in Ogg, whose pre-skip
 * browsers apply exactly (WebM decoded 24 samples early), and the final page's granule position is set to the true
 * length so decoders trim the padding of the last frame.
 */
export async function createStemEncoder(codec: StemCodec, sampleRate: number): Promise<StemEncoder> {
  const opus = codec === 'opus'
  const rate = opus ? OPUS_RATE : sampleRate
  const format = opus ? new OggOutputFormat() : new WavOutputFormat()
  const target = new BufferTarget()
  const output = new Output({ format, target })
  const source = new AudioSampleSource(opus ? { codec, quality: QUALITY_HIGH } : { codec })
  output.addAudioTrack(source)
  await output.start()
  const resamplers: [StreamResampler, StreamResampler] | null =
    rate === sampleRate
      ? null
      : [createStreamResampler(sampleRate, rate), createStreamResampler(sampleRate, rate)]
  let written = 0
  let expected = 0

  const write = async (left: Float32Array, right: Float32Array) => {
    if (left.length === 0) return
    const data = new Float32Array(left.length * 2)
    data.set(left, 0)
    data.set(right, left.length)
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: 2,
      sampleRate: rate,
      timestamp: written / rate,
    })
    written += left.length
    try {
      await source.add(sample)
    } finally {
      sample.close()
    }
  }

  return {
    async add(start, left, right) {
      if (start !== expected)
        throw new Error(`Stem audio must be contiguous: got ${start}, expected ${expected}`)
      expected += left.length
      if (resamplers) await write(resamplers[0].push(left), resamplers[1].push(right))
      else await write(left, right)
    },
    async finish() {
      if (resamplers) await write(resamplers[0].flush(), resamplers[1].flush())
      await output.finalize()
      if (!target.buffer) throw new Error('Stem encoder produced no data')
      if (opus) trimOggOpus(new Uint8Array(target.buffer), written)
      return {
        data: target.buffer,
        mimeType: opus ? 'audio/ogg' : format.mimeType,
        extension: format.fileExtension,
      }
    },
  }
}

interface OggPage {
  offset: number
  size: number
  granule: bigint
}

function oggPages(bytes: Uint8Array): OggPage[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pages: OggPage[] = []
  let offset = 0
  while (offset + 27 <= bytes.length) {
    if (view.getUint32(offset) !== 0x4f676753) throw new Error('Not an Ogg page')
    const segments = view.getUint8(offset + 26)
    let size = 27 + segments
    for (let s = 0; s < segments; s++) size += view.getUint8(offset + 27 + s)
    pages.push({ offset, size, granule: view.getBigInt64(offset + 6, true) })
    offset += size
  }
  return pages
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    table[i] = c >>> 0
  }
  return table
})()

function oggCrc(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0
  return crc
}

/**
 * Ends an Ogg Opus stream after `samples` (48 kHz) by lowering the final page's granule position (RFC 7845 end
 * trimming), in place. The muxer writes the end of the last, padded frame.
 */
function trimOggOpus(bytes: Uint8Array, samples: number): void {
  const pages = oggPages(bytes)
  const head = pages[0]
  const last = pages[pages.length - 1]
  if (!head || !last || pages.length < 2) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // OpusHead: magic (8 bytes), version, channel count, then the pre-skip.
  const packetStart = head.offset + 27 + view.getUint8(head.offset + 26)
  const preSkip = view.getUint16(packetStart + 10, true)
  const end = BigInt(preSkip + samples)
  const previous = (pages[pages.length - 2] as OggPage).granule
  if (end >= last.granule || end < previous) return
  view.setBigInt64(last.offset + 6, end, true)
  view.setUint32(last.offset + 22, 0, true)
  view.setUint32(last.offset + 22, oggCrc(bytes.subarray(last.offset, last.offset + last.size)), true)
}
