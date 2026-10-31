import { DecoderFrameProvider } from '../../engine/frames.ts'
import type { MediaFileSource } from '../../engine/types.ts'
import type { Asset } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import { fitSize, type FrameSource } from './frames.ts'

/**
 * Frame source over a stored video asset that decodes through the engine's export path (WebCodecs via mediabunny,
 * with the same color tagging and rotation handling), so masks and analysis line up with exported pixels.
 * Ascending times decode sequentially. Call dispose() when done.
 */
export function createAssetFrameSource(
  asset: Asset,
  media: MediaFileSource,
): FrameSource & { dispose(): void } {
  const { width, height, duration } = asset
  if (asset.kind !== 'video' || !width || !height || !duration) {
    throw new JobError('decode', `${asset.name} is not a probed video asset`)
  }
  const provider = new DecoderFrameProvider(media)
  const decode = async (t: number, maxSide = Infinity) => {
    try {
      const ref = await provider.videoFrame(asset, t, 'vision')
      if (!ref) throw new JobError('decode', `${asset.name} has no frame at ${t.toFixed(3)} s`)
      const size = fitSize({ width: ref.width, height: ref.height }, maxSide)
      return await createImageBitmap(ref.source, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'medium',
      })
    } finally {
      // The provider closes the frames it handed out, so the bitmap must be made before this.
      provider.endFrame()
    }
  }
  let queue: Promise<unknown> = Promise.resolve()
  return {
    mediaId: asset.id,
    width,
    height,
    duration,
    frameRate: asset.frameRate || 30,
    frameAt(t, options) {
      // The provider has one decode cursor per key, so calls must not interleave.
      const run = queue.then(() => decode(t, options?.maxSide))
      queue = run.catch(() => undefined)
      return run
    },
    dispose() {
      provider.dispose()
    },
  }
}
