import { JobError } from '../shared/jobs.ts'
import type { DecodedAudio } from './beats/fast.ts'

/**
 * Decodes an audio file on the main thread (OfflineAudioContext is not available in workers). Chrome decodes off
 * the main thread; the result is resampled to `sampleRate`.
 */
export async function decodeAudioFile(data: Blob | ArrayBuffer, sampleRate = 44100): Promise<DecodedAudio> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    const buffer = await ctx.decodeAudioData(bytes)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
      buffer.getChannelData(c).slice(),
    )
    return { sampleRate: buffer.sampleRate, channels }
  } catch (error) {
    throw new JobError('decode', 'This audio file could not be decoded', { cause: error })
  }
}
