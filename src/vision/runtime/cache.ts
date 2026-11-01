import { JobError } from '../../shared/jobs.ts'

/** Binary cache for analysis results (mask tracks, depth maps, clip indexes). */
export interface BlobCache {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, data: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

/** Stable, file-name-safe cache key from parts such as kind, media id and a params version. */
export function cacheKey(...parts: Array<string | number>): string {
  const raw = parts.map(String).join('|')
  const readable = parts
    .map((p) => String(p).replace(/[^A-Za-z0-9._-]+/g, '-'))
    .join('__')
    .slice(0, 120)
  return `${readable}__${fnv1a(raw)}`
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function createMemoryCache(): BlobCache {
  const store = new Map<string, Uint8Array>()
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, data) {
      store.set(key, data.slice())
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

/** OPFS-backed cache; falls back to memory where OPFS is unavailable. */
export function createOpfsCache(directory = 'mv-vision-cache'): BlobCache {
  const storage = (globalThis as { navigator?: Navigator }).navigator?.storage
  if (!storage?.getDirectory) return createMemoryCache()
  let dirPromise: Promise<FileSystemDirectoryHandle> | null = null
  const dir = () =>
    (dirPromise ??= storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(directory, { create: true })))
  return {
    async get(key) {
      try {
        const handle = await (await dir()).getFileHandle(key)
        return new Uint8Array(await (await handle.getFile()).arrayBuffer())
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotFoundError') return null
        throw new JobError('internal', `Couldn’t read cached result ${key}`, { cause: err })
      }
    },
    async put(key, data) {
      try {
        const handle = await (await dir()).getFileHandle(key, { create: true })
        const writable = await handle.createWritable()
        await writable.write(data as unknown as ArrayBuffer)
        await writable.close()
      } catch (err) {
        throw new JobError('internal', `Couldn’t store result ${key}`, { cause: err })
      }
    },
    async delete(key) {
      try {
        await (await dir()).removeEntry(key)
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
      }
    },
  }
}
