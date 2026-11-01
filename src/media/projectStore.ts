/** Project storage in IndexedDB, plus portable project files that bundle the project with its media. */
import { parseProject } from '../model/migrations.ts'
import { newId } from '../model/factory.ts'
import type { Asset, Id, Project } from '../model/types.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { mediaStore, type OpfsMediaStore } from './mediaStore.ts'
import { readTar, writeTar, type TarEntry } from './tar.ts'
import type { ProjectStore, ProjectSummary } from './types.ts'

const DB_NAME = 'mv-studio'
const DB_VERSION = 1
const PROJECTS = 'projects'
const SUMMARIES = 'summaries'

export const PORTABLE_EXTENSION = '.mvstudio'
const PROJECT_ENTRY = 'project.json'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

let dbPromise: Promise<IDBDatabase> | undefined
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = undefined
      reject(req.error)
    }
  })
  return dbPromise
}

export class IdbProjectStore implements ProjectStore {
  private readonly media: OpfsMediaStore
  /** Each project's stored thumbnail as last read or written, so a save can keep it without reading first. */
  private readonly thumbnails = new Map<Id, Blob | undefined>()

  constructor(media: OpfsMediaStore = mediaStore) {
    this.media = media
  }

  async list(): Promise<ProjectSummary[]> {
    const db = await openDb()
    const all = await request(
      db.transaction(SUMMARIES).objectStore(SUMMARIES).getAll() as IDBRequest<ProjectSummary[]>,
    )
    for (const s of all) this.thumbnails.set(s.id, s.thumbnail)
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(id: Id): Promise<Project> {
    const db = await openDb()
    const tx = db.transaction([PROJECTS, SUMMARIES])
    const [data, summary] = await Promise.all([
      request(tx.objectStore(PROJECTS).get(id)),
      request(tx.objectStore(SUMMARIES).get(id) as IDBRequest<ProjectSummary | undefined>),
    ])
    if (!data) throw new JobError('invalid-input', 'Project not found')
    this.thumbnails.set(id, summary?.thumbnail)
    return parseProject(data)
  }

  /**
   * Writes the project and its summary in one transaction whose writes are all issued at once and committed right
   * away. A save started as the page closes (autosave on pagehide) then still lands: a transaction that is still
   * waiting to read something when the page goes away is aborted. The summary keeps its thumbnail when none is given.
   */
  async save(project: Project, thumbnail?: Blob): Promise<void> {
    const db = await openDb()
    if (!thumbnail && !this.thumbnails.has(project.id)) {
      const previous = await request(
        db.transaction(SUMMARIES).objectStore(SUMMARIES).get(project.id) as IDBRequest<
          ProjectSummary | undefined
        >,
      )
      if (!this.thumbnails.has(project.id)) this.thumbnails.set(project.id, previous?.thumbnail)
    }
    const kept = thumbnail ?? this.thumbnails.get(project.id)
    this.thumbnails.set(project.id, kept)
    const tx = db.transaction([PROJECTS, SUMMARIES], 'readwrite')
    tx.objectStore(PROJECTS).put(project)
    const summary: ProjectSummary = {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      thumbnail: kept,
    }
    tx.objectStore(SUMMARIES).put(summary)
    tx.commit()
    try {
      await done(tx)
    } catch (error) {
      throw JobError.from(error)
    }
  }

  /** Deletes the project and any media that no other saved project uses. */
  async remove(id: Id): Promise<void> {
    const db = await openDb()
    const project = (await request(db.transaction(PROJECTS).objectStore(PROJECTS).get(id))) as
      Project | undefined
    const tx = db.transaction([PROJECTS, SUMMARIES], 'readwrite')
    tx.objectStore(PROJECTS).delete(id)
    tx.objectStore(SUMMARIES).delete(id)
    await done(tx)
    this.thumbnails.delete(id)
    if (!project) return
    const others = (await request(db.transaction(PROJECTS).objectStore(PROJECTS).getAll())) as Project[]
    const inUse = new Set(others.flatMap((p) => Object.values(p.assets).map((a) => a.storageKey)))
    for (const asset of Object.values(project.assets)) {
      if (!inUse.has(asset.storageKey)) await this.media.remove(asset)
    }
  }

  /**
   * The returned Blob references the OPFS media files instead of copying them, so save it (download or
   * showSaveFilePicker) before deleting or replacing that media.
   */
  async exportPortable(project: Project, ctx?: JobContext): Promise<Blob> {
    const entries: TarEntry[] = [
      { name: PROJECT_ENTRY, data: new Blob([JSON.stringify(project)], { type: 'application/json' }) },
    ]
    const assets = Object.values(project.assets)
    for (const [i, asset] of assets.entries()) {
      ctx?.throwIfCancelled()
      ctx?.progress({
        stage: 'collect',
        fraction: i / Math.max(1, assets.length),
        message: `Adding ${asset.name}`,
      })
      entries.push({ name: asset.storageKey, data: await this.media.getFile(asset) })
    }
    return writeTar(entries)
  }

  /** Imports a portable project file. Media keeps its asset ids; the project gets a new id if one already exists. */
  async importPortable(file: File, ctx?: JobContext): Promise<Project> {
    let entries: TarEntry[]
    try {
      entries = await readTar(file)
    } catch (error) {
      throw new JobError('invalid-input', 'This is not an MV Studio project file', { cause: error })
    }
    const json = entries.find((e) => e.name === PROJECT_ENTRY)
    if (!json) throw new JobError('invalid-input', 'This is not an MV Studio project file')
    let project: Project
    try {
      project = parseProject(JSON.parse(await json.data.text()))
    } catch (error) {
      throw new JobError('invalid-input', error instanceof Error ? error.message : 'Invalid project file', {
        cause: error,
      })
    }
    const byName = new Map(entries.map((e) => [e.name, e.data]))
    const assets = Object.values(project.assets)
    const total = assets.reduce((sum, a) => sum + (byName.get(a.storageKey)?.size ?? 0), 0)
    const started = performance.now()
    let before = 0
    const report = (i: number, written: number) => {
      ctx?.throwIfCancelled()
      const bytes = before + written
      const fraction = total ? bytes / total : i / Math.max(1, assets.length)
      ctx?.progress({
        stage: 'restore',
        fraction,
        message: `Restoring ${assets[i]?.name} · ${i + 1} of ${assets.length} files`,
        bytesLoaded: bytes,
        bytesTotal: total,
        etaSeconds: secondsLeft(started, fraction),
      })
    }
    const restored: Asset[] = []
    let saved = false
    try {
      for (const [i, asset] of assets.entries()) {
        report(i, 0)
        const data = byName.get(asset.storageKey)
        if (!data)
          throw new JobError('invalid-input', `The project file is missing media for "${asset.name}"`)
        if (!(await this.media.has(asset, data.size))) {
          restored.push(asset)
          await this.media.restore(asset, data, (written) => report(i, written))
        }
        before += data.size
      }
      const existing = await this.list()
      if (existing.some((s) => s.id === project.id))
        project = { ...project, id: newId(), name: `${project.name} (imported)` }
      ctx?.throwIfCancelled()
      await this.save(project)
      saved = true
      // A Cancel while it saved (the card still offers one at 100%) must not leave the project kept.
      ctx?.throwIfCancelled()
    } catch (error) {
      // No project refers to the media this open wrote, so a cancel or failure would leave it taking up storage.
      if (saved) await this.remove(project.id).catch(() => undefined)
      await Promise.all(restored.map((a) => this.media.remove(a)))
      throw error
    }
    return project
  }
}

/** Seconds left at the pace so far, once there is enough of it to go by. */
function secondsLeft(started: number, fraction: number): number | undefined {
  const elapsed = (performance.now() - started) / 1000
  if (elapsed < 2 || fraction < 0.05) return undefined
  return (elapsed * (1 - fraction)) / fraction
}

export const projectStore = new IdbProjectStore()
