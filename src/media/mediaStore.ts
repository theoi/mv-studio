/** Media store on OPFS: imported and generated media files, addressed by Asset.storageKey. */
import { newId } from '../model/factory.ts'
import type { Asset, AssetKind, AssetOrigin } from '../model/types.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { opfsFileExists, readOpfsFile, removeOpfsEntry, writeOpfsFile } from './opfs.ts'
import { detectKind, probeMedia } from './probe.ts'
import type { MediaStore } from './types.ts'

const MEDIA_ROOT = 'media'

function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
  return cleaned.slice(-60) || 'file'
}

export function storageKeyFor(assetId: string, name: string): string {
  return `${MEDIA_ROOT}/${assetId}/${safeFileName(name)}`
}

export class OpfsMediaStore implements MediaStore {
  async importFile(file: File, ctx?: JobContext): Promise<Asset> {
    const kind = detectKind(file)
    if (!kind)
      throw new JobError('unsupported', `${file.name} is not a supported audio, video, image or font file`)
    return this.store(file, { kind, name: file.name, origin: { type: 'import' } }, ctx, file.type)
  }

  async storeBlob(
    blob: Blob,
    info: Pick<Asset, 'kind' | 'name' | 'origin'>,
    ctx?: JobContext,
  ): Promise<Asset> {
    return this.store(blob, info, ctx, blob.type)
  }

  /**
   * Writes bytes for an existing asset record (portable project import keeps asset ids and storage keys), with the
   * bytes written so far to `onWritten` (see `writeOpfsFile`).
   */
  async restore(asset: Asset, data: Blob, onWritten?: (bytes: number) => void): Promise<void> {
    await writeOpfsFile(asset.storageKey, data, onWritten)
  }

  /**
   * Whether the asset's file is stored, and with `size`, whether it is whole: a write that stopped part way (a tab
   * closed while a project file opened) leaves an empty file behind.
   */
  async has(asset: Asset, size?: number): Promise<boolean> {
    if (size === undefined) return opfsFileExists(asset.storageKey)
    try {
      return (await readOpfsFile(asset.storageKey)).size === size
    } catch {
      return false
    }
  }

  private async store(
    data: Blob,
    info: { kind: AssetKind; name: string; origin: AssetOrigin },
    ctx: JobContext | undefined,
    mimeType: string,
  ): Promise<Asset> {
    ctx?.progress({ stage: 'probe', message: `Reading ${info.name}` })
    const probe = await probeMedia(data, info.kind, info.name)
    ctx?.throwIfCancelled()
    const id = newId()
    const storageKey = storageKeyFor(id, info.name)
    ctx?.progress({ stage: 'store', message: `Saving ${info.name}`, fraction: 0.5 })
    try {
      await writeOpfsFile(storageKey, data)
    } catch (error) {
      throw JobError.from(error)
    }
    const { mimeType: probedMime, videoCodec: _v, audioCodec: _a, kind: probedKind, ...meta } = probe
    return {
      id,
      kind: probedKind ?? info.kind,
      name: info.name,
      // When the tracks overrode the kind, the file's own type is the wrong one (video/webm for audio).
      mimeType: (probedKind ? probedMime : mimeType || probedMime) || 'application/octet-stream',
      byteSize: data.size,
      storageKey,
      ...meta,
      origin: info.origin,
      createdAt: new Date().toISOString(),
    }
  }

  async getFile(asset: Asset): Promise<File> {
    try {
      return await readOpfsFile(asset.storageKey)
    } catch (error) {
      throw new JobError(
        'invalid-input',
        `The media file for "${asset.name}" is missing from browser storage`,
        { cause: error },
      )
    }
  }

  async remove(asset: Asset): Promise<void> {
    await removeOpfsEntry(asset.storageKey.split('/').slice(0, 2).join('/')).catch(() => undefined)
  }

  async usage(): Promise<{ usedBytes: number; quotaBytes: number; persisted: boolean }> {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted(),
    ])
    return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0, persisted }
  }

  /** Asks the browser not to evict our data under storage pressure. Call after a user gesture (e.g. first import). */
  async requestPersistence(): Promise<boolean> {
    return navigator.storage.persisted().then((p) => p || navigator.storage.persist())
  }
}

export const mediaStore = new OpfsMediaStore()
