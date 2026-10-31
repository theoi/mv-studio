import type { MediaFileSource } from '../../engine/types.ts'
import { mediaStore } from '../../media/mediaStore.ts'
import { isSampleAsset, sampleFile } from '../mock/sampleMedia.ts'

/** Where preview and export read media: imported files from browser storage, sample media generated on demand. */
export const appMedia: MediaFileSource = {
  getFile: (asset) => (isSampleAsset(asset) ? sampleFile(asset) : mediaStore.getFile(asset)),
}
