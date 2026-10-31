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

export async function writeOpfsFile(path: string, data: Blob | BufferSource): Promise<void> {
  const { dir, name } = await dirFor(path, true)
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(data)
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
