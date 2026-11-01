/** Helpers over the Origin Private File System. Paths use '/' separators relative to the OPFS root. */

async function dirFor(
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`Invalid OPFS path: ${path}`)
  let dir = await navigator.storage.getDirectory()
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create })
  return { dir, name }
}

/** Bytes written at a time when the caller follows a write's progress. */
const WRITE_CHUNK = 8 * 1024 * 1024

/**
 * Writes a file. With `onWritten`, a Blob is written in chunks and `onWritten` gets the bytes written so far after
 * each one. It may throw (a cancel), which stops the write and discards what it wrote.
 */
export async function writeOpfsFile(
  path: string,
  data: Blob | BufferSource,
  onWritten?: (bytes: number) => void,
): Promise<void> {
  const { dir, name } = await dirFor(path, true)
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    if (onWritten && data instanceof Blob) {
      for (let offset = 0; offset < data.size; offset += WRITE_CHUNK) {
        await writable.write(data.slice(offset, offset + WRITE_CHUNK))
        onWritten(Math.min(data.size, offset + WRITE_CHUNK))
      }
    } else await writable.write(data)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

export async function readOpfsFile(path: string): Promise<File> {
  const { dir, name } = await dirFor(path, false)
  return (await dir.getFileHandle(name)).getFile()
}

export async function opfsFileExists(path: string): Promise<boolean> {
  try {
    await readOpfsFile(path)
    return true
  } catch {
    return false
  }
}

export async function removeOpfsEntry(path: string): Promise<void> {
  const { dir, name } = await dirFor(path, false)
  await dir.removeEntry(name, { recursive: true })
}

/** Opens a writable stream for large outputs (exports) without buffering them in memory. */
export async function createOpfsWritable(
  path: string,
): Promise<{ writable: FileSystemWritableFileStream; handle: FileSystemFileHandle }> {
  const { dir, name } = await dirFor(path, true)
  const handle = await dir.getFileHandle(name, { create: true })
  return { writable: await handle.createWritable(), handle }
}
