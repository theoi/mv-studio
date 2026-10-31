/** Reads media metadata (duration, size, frame rate, audio format) without decoding the whole file. */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import type { Asset, AssetKind } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'

const AUDIO_EXT = /\.(mp3|wav|wave|flac|m4a|aac|ogg|oga|opus|weba)$/i
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const FONT_EXT = /\.(ttf|otf|woff2?)$/i

export function detectKind(file: { name: string; type: string }): AssetKind | null {
  const t = file.type
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio'
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video'
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image'
  if (t.startsWith('font/') || FONT_EXT.test(file.name)) return 'font'
  return null
}

export type MediaProbe = Pick<
  Asset,
  'duration' | 'width' | 'height' | 'frameRate' | 'hasAudio' | 'sampleRate' | 'channels'
> & {
  /** Set when the tracks show the file is a different kind than its name or type suggested. */
  kind?: AssetKind
  mimeType?: string
  videoCodec?: string
  audioCodec?: string
}

async function probeAv(file: Blob, guess: 'audio' | 'video'): Promise<MediaProbe> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    // WebM, MP4 and Ogg files may hold only audio (e.g. a .webm voice recording, which browsers type video/webm).
    const kind = guess === 'video' && !video && audio ? 'audio' : guess
    if (kind === 'video' && !video) throw new JobError('decode', 'This file has no video track')
    if (kind === 'audio' && !audio) throw new JobError('decode', 'This file has no audio track')
    let mimeType = await input.getMimeType()
    if (kind === 'audio') mimeType = mimeType.replace(/^video\//, 'audio/')
    const out: MediaProbe = { duration: await input.computeDuration(), mimeType }
    if (kind !== guess) out.kind = kind
    if (video && kind === 'video') {
      if (!(await video.canDecode()))
        throw new JobError('unsupported', `This browser cannot decode ${video.codec ?? 'this'} video`)
      out.width = video.displayWidth
      out.height = video.displayHeight
      out.videoCodec = (await video.getCodecParameterString()) ?? undefined
      const stats = await video.computePacketStats(120)
      out.frameRate = stats.averagePacketRate
    }
    if (audio) {
      out.hasAudio = true
      out.sampleRate = audio.sampleRate
      out.channels = audio.numberOfChannels
      out.audioCodec = (await audio.getCodecParameterString()) ?? undefined
    } else out.hasAudio = false
    return out
  } catch (error) {
    if (error instanceof JobError) throw error
    throw new JobError(
      'decode',
      'Could not read this media file. It may be damaged or in an unsupported format.',
      { cause: error },
    )
  } finally {
    input.dispose()
  }
}

async function probeImage(file: Blob): Promise<MediaProbe> {
  try {
    const bitmap = await createImageBitmap(file)
    const out = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return out
  } catch (error) {
    throw new JobError('decode', 'Could not read this image', { cause: error })
  }
}

async function probeFont(file: Blob, name: string): Promise<MediaProbe> {
  try {
    const face = new FontFace(`probe-${name}`, await file.arrayBuffer())
    await face.load()
    return {}
  } catch (error) {
    throw new JobError('decode', 'Could not read this font', { cause: error })
  }
}

export async function probeMedia(file: Blob, kind: AssetKind, name: string): Promise<MediaProbe> {
  if (kind === 'audio' || kind === 'video') return probeAv(file, kind)
  if (kind === 'image') return probeImage(file)
  return probeFont(file, name)
}
