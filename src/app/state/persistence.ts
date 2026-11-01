import { create } from 'zustand'
import { OpfsMediaStore, mediaStore } from '../../media/mediaStore.ts'
import { IdbProjectStore, PORTABLE_EXTENSION } from '../../media/projectStore.ts'
import {
  newId,
  projectDuration,
  startAutosave,
  type Asset,
  type AutosaveController,
  type AutosaveState,
  type AutosaveStatus,
  type Clip,
  type Id,
  type Project,
} from '../../model/index.ts'
import { templateState } from '../../plugins/templates.ts'
import { JobError, jobs, type JobErrorCode } from '../../shared/jobs.ts'
import { distinctName } from '../format.ts'
import { isSampleAsset, sampleFile } from '../mock/sampleMedia.ts'
import { JOB_KINDS, isRunning } from './jobs.ts'
import { usePrefs } from './prefs.ts'
import { dispatch, editor, loadEmptyProject } from './project.ts'
import { thumbnailBlob } from './thumbs.ts'
import { get, set, toast, useUi } from './ui.ts'

/*
 * Projects kept in this browser: autosave of the open project, the recent projects on the start screen, and project
 * files (.mvstudio) that carry a project and its media to another browser or computer.
 *
 * A project opened from the sample or as a blank one is only kept once the user changes it (or presses Mod S), so
 * looking around never fills the recent projects. Background analysis alone does not count as a change.
 */

/** Sample media is generated rather than stored, so project files and copies take its bytes from the generator. */
class AppMediaStore extends OpfsMediaStore {
  override async getFile(asset: Asset): Promise<File> {
    if (!isSampleAsset(asset)) return super.getFile(asset)
    return new File([await sampleFile(asset)], asset.name)
  }
}

const store = new IdbProjectStore(new AppMediaStore())

export interface RecentProject {
  id: Id
  name: string
  updatedAt: string
  /** The kind of video it was started as ('lyric', 'visualizer', 'footage', 'ai' or 'blank'), when known. */
  kind?: string
  /** A frame of the project's footage as a data URL; absent when it has none. */
  thumbnail?: string
}

interface PersistenceState {
  status: AutosaveStatus
  error?: string
  /** The open project is kept in this browser, or will be with the next save. */
  tracked: boolean
  /** Kept projects, most recently edited first; null until listed. */
  recents: RecentProject[] | null
  /** The project a link or the last visit points to is loading, so the editor shows nothing else meanwhile. */
  restoring: boolean
}

export const usePersistence = create<PersistenceState>(() => ({
  status: 'idle',
  tracked: false,
  recents: null,
  restoring: false,
}))

const LAST_KEY = 'mv-studio.last-project'

const storedIds = new Set<Id>()
/** Kept projects' names, for unusedProjectName(). */
const storedNames = new Map<Id, string>()
/** Projects deleted in this session; a late autosave must not bring them back. */
const removed = new Set<Id>()
/** The cover asset each project's stored thumbnail shows, so thumbnails are only made when it changes. */
const covers = new Map<Id, Id | null>()
let edited = false
let tracking = true
let autosave: AutosaveController | null = null
let previous: Project = editor.getProject()
let persistenceAsked = false
let failSaves: JobErrorCode | null = null

export function isStored(id: Id): boolean {
  return storedIds.has(id)
}

/**
 * `name`, or "name (2)", "name (3)"... when another kept project already has it, so projects made from one song can be
 * told apart in Recent projects and their exports get different file names.
 */
export function unusedProjectName(name: string, except?: Id): string {
  return distinctName(
    name,
    [...storedNames].flatMap(([id, n]) => (id === except ? [] : [n])),
  )
}

/** Runs edits that are not the user's (design-preview deep links), so they don't make a project worth keeping. */
export function untracked(run: () => void): void {
  tracking = false
  try {
    run()
  } finally {
    tracking = true
  }
}

function syncCurrent() {
  const tracked = storedIds.has(editor.getProject().id) || edited
  if (usePersistence.getState().tracked !== tracked) usePersistence.setState({ tracked })
}

function rememberLast(id: Id) {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // Storage blocked: the next visit starts on the start screen.
  }
}

function forgetLast() {
  try {
    localStorage.removeItem(LAST_KEY)
  } catch {
    // Nothing to forget.
  }
}

function lastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

export function saveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'SaveError') return error.message
  const e = JobError.from(error)
  if (e.code === 'storage-quota')
    return 'This browser’s storage is full. Free space in Settings › Storage, or download the project file.'
  return `Couldn’t save in this browser: ${e.message}`
}

function isVisual(c: Clip): c is Extract<Clip, { type: 'video' | 'image' }> {
  return c.type === 'video' || c.type === 'image'
}

/** The clip the start screen shows for a project: the one playing about a third of the way in. */
export function coverAsset(project: Project): Asset | undefined {
  const clips = Object.values(project.clips)
    .filter(isVisual)
    .sort((a, b) => a.start - b.start)
  const at = projectDuration(project) * 0.35
  const clip = clips.find((c) => c.start <= at && c.start + c.duration > at) ?? clips[0]
  return clip ? project.assets[clip.assetId] : undefined
}

/** A new thumbnail when the project's cover changed since its last one was stored, else undefined. */
async function thumbnailFor(project: Project): Promise<{ cover: Id | null; blob?: Blob } | undefined> {
  const asset = coverAsset(project)
  const cover = asset?.id ?? null
  if (covers.has(project.id) && covers.get(project.id) === cover) return undefined
  const blob = asset ? await thumbnailBlob(asset).catch(() => null) : null
  return blob ? { cover, blob } : { cover }
}

let writes = 0
/** The newest write of each project, so an older one still making its thumbnail doesn't overwrite it. */
const latestWrite = new Map<Id, number>()

/**
 * Stores the project. When the page is `leaving`, it is written at once without making a thumbnail: decoding a frame
 * takes longer than a closing page lives, and the card keeps its earlier thumbnail until the next save.
 */
async function writeProject(project: Project, leaving = false): Promise<void> {
  if (removed.has(project.id)) return
  const write = ++writes
  latestWrite.set(project.id, write)
  try {
    if (failSaves) throw new JobError(failSaves, 'Save failed for the test')
    const thumbnail = leaving ? undefined : await thumbnailFor(project)
    if (latestWrite.get(project.id) !== write) return
    await store.save(project, thumbnail?.blob, templateState(project)?.kind)
    if (thumbnail) covers.set(project.id, thumbnail.cover)
  } catch (error) {
    const failure = new Error(saveErrorMessage(error), { cause: error })
    failure.name = 'SaveError'
    throw failure
  }
  storedIds.add(project.id)
  storedNames.set(project.id, project.name)
  if (!persistenceAsked) {
    persistenceAsked = true
    void mediaStore.requestPersistence().catch(() => false)
  }
  // The list reads every thumbnail, so it is refreshed for the start screen only (and when it opens).
  if (get().screen === 'start') void refreshRecents()
}

async function autosaveProject(project: Project, { leaving }: { leaving: boolean }): Promise<void> {
  if (!storedIds.has(project.id) && !edited) return
  await writeProject(project, leaving)
  if (editor.getProject().id === project.id && get().screen === 'editor') rememberLast(project.id)
  syncCurrent()
}

function onEditorChange(project: Project, change: { source: string }) {
  if (change.source === 'load') {
    // Another project replaced this one before its last change was written.
    const prev = previous
    const unsaved =
      autosave && autosave.getState().status !== 'saved' && autosave.getState().status !== 'idle'
    if (unsaved && prev.id !== project.id && (storedIds.has(prev.id) || edited))
      writeProject(prev).catch((error: unknown) => toast(saveErrorMessage(error)))
    edited = false
  } else if (tracking && change.source !== 'derived') {
    edited = true
  }
  previous = project
  syncCurrent()
}

function onAutosave(state: AutosaveState) {
  const before = usePersistence.getState().status
  usePersistence.setState({ status: state.status, error: state.error })
  if (state.status === 'error' && before !== 'error' && usePersistence.getState().tracked)
    toast(state.error ?? 'Couldn’t save in this browser', {
      label: 'Download project file',
      run: () => downloadProjectFile(),
    })
}

function timing(seconds: number) {
  return seconds >= 30 ? { delayMs: 5000, maxDelayMs: 30_000 } : { delayMs: 800, maxDelayMs: 5000 }
}

function startSaving(seconds: number) {
  const controller = startAutosave(editor, autosaveProject, { ...timing(seconds), target: window })
  controller.subscribe(onAutosave)
  return controller
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  const { status, tracked } = usePersistence.getState()
  if (!tracked || status === 'saved' || status === 'idle') return
  void autosave?.flush({ leaving: true })
  e.preventDefault()
}

/** Jobs working on the open project; their results would land in the next one. Exports render a snapshot. */
function cancelProjectJobs(keep: readonly string[] = []) {
  for (const job of jobs.list()) {
    const active = job.status === 'running' || job.status === 'queued'
    if (
      active &&
      job.kind !== JOB_KINDS.export &&
      !job.kind.startsWith('project.') &&
      !keep.includes(job.kind)
    )
      jobs.cancel(job.id)
  }
}

function show(project: Project) {
  cancelProjectJobs()
  storedIds.add(project.id)
  editor.load(project)
  rememberLast(project.id)
}

const editorUi = {
  screen: 'editor',
  selection: { type: 'none' },
  playhead: 0,
  playing: false,
  dialog: null,
  paletteOpen: false,
  rightTab: 'inspector',
  assistView: 'home',
} as const

/**
 * Loads the project the setup screen is building, after writing the open one, so the song's analysis has a project to
 * land in. It is not kept. Files the setup screen is still copying into storage keep going.
 */
export async function loadSetupDraft(project: Project): Promise<void> {
  await autosave?.flush()
  cancelProjectJobs([JOB_KINDS.import])
  editor.load(project)
}

/**
 * Opens a project made on the setup screen. `keep` saves it right away, so it is in the recent projects and a reload
 * reopens it. `fromDraft` keeps the jobs started for the setup draft (the song's analysis), whose results move over.
 */
export async function startProject(project: Project, options: { keep: boolean; fromDraft: boolean }) {
  await autosave?.flush()
  if (!options.fromDraft) cancelProjectJobs()
  if (options.keep) {
    try {
      await writeProject(project)
    } catch (error) {
      toast(saveErrorMessage(error))
    }
  }
  editor.load(project)
  if (storedIds.has(project.id)) rememberLast(project.id)
}

/** Loads a kept project into the editor, after writing the open one. Returns false when it is not there. */
export async function openStoredProject(id: Id): Promise<boolean> {
  await autosave?.flush()
  let project: Project
  try {
    project = await store.load(id)
  } catch {
    return false
  }
  show(project)
  return true
}

/** Opens a kept project from the start screen or a toast. */
export async function openProject(id: Id): Promise<void> {
  if (await openStoredProject(id)) {
    set(editorUi)
    return
  }
  toast('That project isn’t in this browser anymore.')
  void refreshRecents()
}

/** Opens the project a link names (`#/editor?project=<id>`), unless it is already open. */
export function openFromLink(id: Id): void {
  if (editor.getProject().id === id) return
  usePersistence.setState({ restoring: true })
  void openStoredProject(id).then((ok) => {
    usePersistence.setState({ restoring: false })
    if (ok) return
    set({ screen: 'start', dialog: null })
    toast('That project isn’t in this browser anymore.')
  })
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function refreshRecents(): Promise<void> {
  let list
  try {
    list = await store.list()
  } catch {
    usePersistence.setState({ recents: [] })
    return
  }
  storedIds.clear()
  storedNames.clear()
  for (const s of list) {
    storedIds.add(s.id)
    storedNames.set(s.id, s.name)
  }
  const recents = await Promise.all(
    list.map(async (s) => ({
      id: s.id,
      name: s.name,
      updatedAt: s.updatedAt,
      ...(s.kind ? { kind: s.kind } : {}),
      thumbnail: s.thumbnail ? await readDataUrl(s.thumbnail).catch(() => undefined) : undefined,
    })),
  )
  usePersistence.setState({ recents })
  syncCurrent()
}

/** Mod S: writes the open project now, keeping it even when nothing changed since it opened. */
export async function saveNow(): Promise<void> {
  const project = editor.getProject()
  edited = true
  syncCurrent()
  if (!autosave) return
  if (storedIds.has(project.id)) {
    await autosave.flush()
    if (autosave.getState().status === 'error') return
  } else {
    try {
      usePersistence.setState({ status: 'saving' })
      await writeProject(project)
      usePersistence.setState({ status: 'saved', error: undefined })
    } catch (error) {
      const message = saveErrorMessage(error)
      usePersistence.setState({ status: 'error', error: message })
      toast(message)
      return
    }
  }
  rememberLast(project.id)
  toast('Saved in this browser')
}

export async function renameProject(id: Id, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  if (editor.getProject().id === id) {
    if (trimmed !== editor.getProject().name)
      dispatch({ type: 'project.rename', name: trimmed }, { label: 'Rename project' })
    return
  }
  try {
    const project = await store.load(id)
    await writeProject({ ...project, name: trimmed, updatedAt: new Date().toISOString() })
  } catch (error) {
    toast(saveErrorMessage(error))
  }
}

/** Keeps a copy of a project under a new id and returns it. */
export async function duplicateProject(id: Id): Promise<Project> {
  const source = editor.getProject().id === id ? editor.getProject() : await store.load(id)
  const now = new Date().toISOString()
  // Numbered like projects of one song: a copy of "Neon Skyline (2)" is the next free "Neon Skyline (n)".
  const name = distinctName(source.name.replace(/ \(\d+\)$/, ''), [...storedNames.values(), source.name])
  const copy = { ...source, id: newId(), name, createdAt: now, updatedAt: now }
  await writeProject(copy)
  return copy
}

export async function duplicateCurrent(): Promise<void> {
  try {
    const copy = await duplicateProject(editor.getProject().id)
    toast(`Saved a copy: “${copy.name}”`, { label: 'Open', run: () => void openProject(copy.id) })
  } catch (error) {
    toast(saveErrorMessage(error))
  }
}

/** Deletes a kept project, and its media unless another kept project uses it. */
export async function deleteProject(id: Id): Promise<void> {
  removed.add(id)
  storedIds.delete(id)
  storedNames.delete(id)
  if (lastProjectId() === id) forgetLast()
  if (editor.getProject().id === id) loadEmptyProject()
  try {
    await store.remove(id)
  } catch (error) {
    toast(`Couldn’t delete the project: ${JobError.from(error).message}`)
  }
  await refreshRecents()
}

export function portableFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled video'
  return `${base}${PORTABLE_EXTENSION}`
}

/** Downloads a project file with the project and all its media: the open project, or a kept one. */
export function downloadProjectFile(id?: Id): void {
  if (isRunning(JOB_KINDS.projectExport)) return
  const handle = jobs.run({
    kind: JOB_KINDS.projectExport,
    title: 'Preparing the project file',
    run: async (ctx) => {
      const project = !id || id === editor.getProject().id ? editor.getProject() : await store.load(id)
      return { name: portableFileName(project.name), blob: await store.exportPortable(project, ctx) }
    },
  })
  handle.promise.then(
    ({ name, blob }) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast(`Downloaded “${name}”`)
    },
    (error: unknown) => {
      const e = JobError.from(error)
      if (e.code !== 'cancelled') toast(`Couldn’t make the project file: ${e.message}`)
    },
  )
}

/** Opens a project file: its media goes into browser storage and the project opens in the editor. */
export async function importProjectFile(file: File): Promise<void> {
  const handle = jobs.run({
    kind: JOB_KINDS.projectImport,
    title: `Opening ${file.name}`,
    run: (ctx) => store.importPortable(file, ctx),
  })
  try {
    const project = await handle.promise
    await autosave?.flush()
    show(project)
    set(editorUi)
    toast(`Opened “${project.name}”`)
    void refreshRecents()
  } catch (error) {
    const e = JobError.from(error)
    if (e.code === 'cancelled') return
    toast(
      e.code === 'storage-quota'
        ? 'There isn’t enough browser storage to open this project. Free space in Settings › Storage.'
        : e.message,
    )
  }
}

export function openProjectFile(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = PORTABLE_EXTENSION
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void importProjectFile(file)
  }
  input.click()
}

/** For end-to-end tests: make saves fail as if storage were full (or another error), or work again with null. */
export function failSavesForTests(code: JobErrorCode | null): void {
  failSaves = code
}

let started = false

/**
 * Starts autosave and lists the kept projects. On a visit without a link, reopens the project the user was working
 * on when they left; leaving for the start screen forgets it.
 */
export function initPersistence(): void {
  if (started) return
  started = true
  previous = editor.getProject()
  editor.subscribe(onEditorChange)
  autosave = startSaving(usePrefs.getState().autosaveSeconds)
  usePrefs.subscribe((p, prev) => {
    if (p.autosaveSeconds === prev.autosaveSeconds || !autosave) return
    const old = autosave
    autosave = startSaving(p.autosaveSeconds)
    void old.flush().finally(() => old.stop())
  })
  useUi.subscribe((s, prev) => {
    if (s.screen === prev.screen || s.screen !== 'start') return
    forgetLast()
    void refreshRecents()
  })
  window.addEventListener('beforeunload', onBeforeUnload)
  void refreshRecents()
  const last = window.location.hash ? null : lastProjectId()
  if (!last) return
  usePersistence.setState({ restoring: true })
  void openStoredProject(last).then((ok) => {
    if (ok) set(editorUi)
    else forgetLast()
    usePersistence.setState({ restoring: false })
  })
}
