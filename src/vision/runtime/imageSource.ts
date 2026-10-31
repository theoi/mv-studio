import type { MediaFileSource } from '../../engine/types.ts'
import type { Asset } from '../../model/types.ts'
import { JobError } from '../../shared/jobs.ts'
import { fitSize, type FrameSource } from './frames.ts'

/** Length a still counts as when it is analyzed like a clip: every time shows the same picture. */
export const STILL_SOURCE_SECONDS = 1

/** Frame source over a stored image, so stills go through the same analysis as clips. Call dispose() when done. */
export async function createImageFrameSource(
  asset: Asset,
  media: MediaFileSource,
): Promise<FrameSource & { dispose(): void }> {
  if (asset.kind !== 'image') throw new JobError('decode', `${asset.name} is not an image`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(await media.getFile(asset))
  } catch (err) {
    throw new JobError('decode', `${asset.name} could not be decoded`, { cause: err })
  }
  return {
    mediaId: asset.id,
    width: bitmap.width,
    height: bitmap.height,
    duration: STILL_SOURCE_SECONDS,
    frameRate: 1,
    frameAt(_t, options) {
      const size = fitSize(bitmap, options?.maxSide ?? Infinity)
      return createImageBitmap(bitmap, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'medium',
      })
    },
    dispose() {
      bitmap.close()
    },
  }
}
