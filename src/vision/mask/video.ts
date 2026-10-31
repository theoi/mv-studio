import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
} from 'mediabunny'
import type { Asset, Id, Matte } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import { throwIfAborted, visionError } from '../errors.ts'
import { createProgress, type TaskOptions } from '../runtime/tasks.ts'
import type { PackedMaskTrack } from '../types.ts'
import { createTrackReader } from './track.ts'

/**
 * Encodes a mask track as a grayscale video aligned with its source footage (video time = source time), the form
 * the compositor's matte pass reads (`Matte.maskAssetId`, red channel). Frames before the track start are empty;
 * the last mask is held until `duration`.
 */
export async function encodeMaskVideo(
  track: PackedMaskTrack,
  options: TaskOptions & { duration: number },
): Promise<Blob> {
  const { meta } = track
  const { width, height } = meta.maskSize
  if (meta.frameCount === 0) throw new JobError('invalid-input', 'The mask track is empty.')
  const codec = await getFirstEncodableVideoCodec(['vp9', 'avc', 'vp8'], { width, height })
  if (!codec) throw new JobError('unsupported', 'This browser cannot encode video.')
  const format = codec === 'avc' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat()
  const target = new BufferTarget()
  const output = new Output({ format, target })
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new JobError('unsupported', '2D canvas is not available.')
  // One key frame per second keeps seeking cheap for the preview's <video>-based frame provider.
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_VERY_HIGH, keyFrameInterval: 1 })
  output.addVideoTrack(source, { frameRate: meta.fps })
  const progress = createProgress(options.onProgress)
  const reader = createTrackReader(track, 2)
  const image = new ImageData(width, height)
  const draw = (data: Uint8Array | null) => {
    const px = image.data
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      const v = data ? data[i]! : 0
      px[j] = v
      px[j + 1] = v
      px[j + 2] = v
      px[j + 3] = 255
    }
    ctx.putImageData(image, 0, 0)
  }
  try {
    await output.start()
    const step = 1 / meta.fps
    if (meta.start > 1e-6) {
      draw(null)
      await source.add(0, meta.start)
    }
    for (let i = 0; i < meta.frameCount; i++) {
      throwIfAborted(options.signal)
      const t = meta.start + i * step
      const last = i === meta.frameCount - 1
      draw(reader.frame(i).data)
      await source.add(t, last ? Math.max(step, options.duration - t) : step)
      progress((i + 1) / meta.frameCount, 'encoding-mask')
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => undefined)
    throw visionError(err, 'encode')
  }
  if (!target.buffer) throw new JobError('encode', 'The mask video is empty.')
  return new Blob([target.buffer], { type: format.mimeType })
}

/** Asset info for storing a mask video with `MediaStore.storeBlob`. */
export function maskAssetInfo(
  source: Pick<Asset, 'id' | 'name'>,
  blob: Blob,
): Pick<Asset, 'kind' | 'name' | 'origin'> {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
  return {
    kind: 'video',
    name: `${source.name.replace(/\.[^.]+$/, '')} (subject mask).${ext}`,
    origin: { type: 'derived', parentAssetId: source.id },
  }
}

/** Matte that shows a layer (e.g. lyrics) only behind the subject of `sourceAssetId`. */
export function behindSubjectMatte(maskAssetId: Id, sourceAssetId: Id, feather = 0.2): Matte {
  return { maskAssetId, sourceAssetId, mode: 'outside', feather }
}
