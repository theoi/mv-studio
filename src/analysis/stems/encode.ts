import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  canEncodeAudio,
  Output,
  QUALITY_HIGH,
  WavOutputFormat,
  WebMOutputFormat,
} from 'mediabunny'

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

/** Opus in WebM (about 5 MB per stem for a 4-minute song) when the browser can encode it, else 16-bit WAV. */
export async function pickStemCodec(sampleRate: number): Promise<StemCodec> {
  try {
    if (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate })) return 'opus'
  } catch {
    // No WebCodecs encoder (e.g. outside a browser): fall through to PCM.
  }
  return 'pcm-s16'
}

export async function createStemEncoder(codec: StemCodec, sampleRate: number): Promise<StemEncoder> {
  const format = codec === 'opus' ? new WebMOutputFormat() : new WavOutputFormat()
  const target = new BufferTarget()
  const output = new Output({ format, target })
  const source = new AudioSampleSource(codec === 'opus' ? { codec, quality: QUALITY_HIGH } : { codec })
  output.addAudioTrack(source)
  await output.start()
  return {
    async add(start, left, right) {
      const data = new Float32Array(left.length * 2)
      data.set(left, 0)
      data.set(right, left.length)
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate,
        timestamp: start / sampleRate,
      })
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
    },
    async finish() {
      await output.finalize()
      if (!target.buffer) throw new Error('Stem encoder produced no data')
      // WebM reports a video MIME type even for audio-only files.
      const mimeType = codec === 'opus' ? 'audio/webm' : format.mimeType
      return { data: target.buffer, mimeType, extension: format.fileExtension }
    },
  }
}
