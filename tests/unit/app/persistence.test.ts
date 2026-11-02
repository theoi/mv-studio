import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, type Project } from '../../../src/model/index.ts'
import {
  chooseSameProject,
  duplicateProject,
  importProjectFile,
  leaveProjectJobs,
  loadSample,
  refreshRecents,
  usePersistence,
} from '../../../src/app/state/persistence.ts'
import { answerLeaveDraft, holdDrafts, useLeaveDraft } from '../../../src/app/state/leaveDraft.ts'
import { set, toast } from '../../../src/app/state/ui.ts'
import { jobs } from '../../../src/shared/jobs.ts'
import { editor } from '../../../src/app/state/project.ts'

const store = vi.hoisted(() => ({
  kept: new Map<string, Project>(),
  saved: [] as string[],
  /** The project in the project file being opened. */
  incoming: null as Project | null,
  listFails: false,
  /** The names project files were opened under. */
  opened: [] as (string | undefined)[],
}))

vi.mock('../../../src/app/state/ui.ts', () => ({
  get: () => ({ playhead: 0, screen: 'editor', selection: { type: 'none' } }),
  set: vi.fn(),
  toast: vi.fn(),
  useUi: { subscribe: vi.fn() },
  withdrawUndo: vi.fn(),
}))

vi.mock('../../../src/media/mediaStore.ts', () => ({
  OpfsMediaStore: class {},
  mediaStore: { requestPersistence: async () => true },
}))

vi.mock('../../../src/media/projectStore.ts', () => ({
  PORTABLE_EXTENSION: '.mvstudio',
  readPortable: async () => ({ project: store.incoming, files: new Map() }),
  IdbProjectStore: class {
    async list() {
      if (store.listFails) throw new DOMException('The database connection is closing', 'InvalidStateError')
      return [...store.kept.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
    }
    async load(id: string) {
      return store.kept.get(id)
    }
    async save(project: Project) {
      store.saved.push(project.name)
      store.kept.set(project.id, project)
    }
    async importPortable(_file: File, _ctx: unknown, name?: string) {
      store.opened.push(name)
      return { ...store.incoming!, name: name ?? store.incoming!.name }
    }
  },
}))

const keep = (name: string) => {
  const project = createProject({ name })
  store.kept.set(project.id, project)
  return project
}

beforeEach(() => {
  store.kept.clear()
  store.saved.length = 0
  store.incoming = null
  store.listFails = false
  store.opened.length = 0
  vi.mocked(toast).mockClear()
})

it('numbers a copy from (2) even when no project has the name without the number', async () => {
  // The original "Neon Skyline" was deleted; only its copy is kept.
  const copy = keep('Neon Skyline (2)')
  editor.load(createProject({ name: 'Untitled video' }))
  await refreshRecents()
  expect((await duplicateProject(copy.id)).name).toBe('Neon Skyline (3)')
})

it('keeps a year in parentheses as part of the name', async () => {
  const live = keep('Live (2019)')
  editor.load(createProject({ name: 'Untitled video' }))
  await refreshRecents()
  expect((await duplicateProject(live.id)).name).toBe('Live (2019) (2)')
})

it('takes no name the open project has, kept or not', async () => {
  const kept = keep('Neon Skyline (2)')
  editor.load(createProject({ name: 'Neon Skyline (3)' }))
  await refreshRecents()
  expect((await duplicateProject(kept.id)).name).toBe('Neon Skyline (4)')
  expect(store.saved).toEqual(['Neon Skyline (4)'])
})

const projectFile = new File(['tar'], 'Portable.mvstudio')

it('offers a copy of a kept "Portable (2)" as "Portable (3)", not "Portable (2) (2)"', async () => {
  keep('Portable')
  store.incoming = keep('Portable (2)')
  const opening = importProjectFile(projectFile)
  await vi.waitFor(() => expect(usePersistence.getState().sameProject).not.toBeNull())
  expect(usePersistence.getState().sameProject?.copyName).toBe('Portable (3)')
  chooseSameProject('copy')
  await opening
  expect(store.opened).toEqual(['Portable (3)'])
})

it('opens another project of a kept name under the next free number, without asking', async () => {
  keep('Portable')
  store.incoming = createProject({ name: 'Portable' })
  await importProjectFile(projectFile)
  expect(usePersistence.getState().sameProject).toBeNull()
  expect(store.opened).toEqual(['Portable (2)'])
})

it('keeps the name of a project file no kept project has, numbers and all', async () => {
  store.incoming = createProject({ name: 'Portable (2)' })
  await importProjectFile(projectFile)
  expect(store.opened).toEqual(['Portable (2)'])
})

it('opens nothing and says so when the kept projects cannot be read', async () => {
  keep('Portable')
  store.incoming = createProject({ name: 'Portable' })
  store.listFails = true
  await importProjectFile(projectFile)
  expect(store.opened).toEqual([])
  expect(usePersistence.getState().sameProject).toBeNull()
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Couldn’t open Portable\.mvstudio: /))
})

it('says the project is already open when the one here is the one being edited', async () => {
  const open = keep('Portable')
  editor.load(open)
  store.incoming = open
  const opening = importProjectFile(projectFile)
  await vi.waitFor(() => expect(usePersistence.getState().sameProject).not.toBeNull())
  chooseSameProject('open')
  await opening
  expect(toast).toHaveBeenCalledWith('“Portable” is already open')
  expect(store.opened).toEqual([])
})

it('cancels the open project’s running jobs and puts away its finished results when another project opens, but not exports', async () => {
  const project = createProject({ name: 'Open' })
  editor.load(project)
  const settle = (p: Promise<unknown>) => p.catch(() => undefined)
  const cut = jobs.run({ kind: 'edit.autocut', title: 'Cut', run: async () => 1 })
  const failed = jobs.run({
    kind: 'vision.camera',
    title: 'Camera',
    run: async () => {
      throw new Error('no depth')
    },
  })
  const exported = jobs.run({ kind: 'export.outputs', title: 'Export', run: async () => 1 })
  await Promise.all([cut.promise, settle(failed.promise), exported.promise])
  const running = jobs.run({
    kind: 'analysis.stems',
    title: 'Stems',
    run: (ctx) =>
      new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))),
  })
  const dismissedAfter = () => {
    const update = vi.mocked(set).mock.calls.at(-1)?.[0] as
      ((s: { dismissed: string[] }) => { dismissed: string[] }) | undefined
    return update?.({ dismissed: ['earlier'] }).dismissed
  }

  vi.mocked(set).mockClear()
  // The same project opening again keeps its results; its running jobs still stop.
  leaveProjectJobs({ next: project.id })
  expect(vi.mocked(set)).not.toHaveBeenCalled()
  await settle(running.promise)
  expect(jobs.list().find((j) => j.id === running.id)?.status).toBe('cancelled')

  leaveProjectJobs({ next: 'another' })
  expect(dismissedAfter()).toEqual(['earlier', cut.id, failed.id])
})

it('leaves the open project’s jobs before Use a sample replaces it with the sample', async () => {
  editor.load(createProject({ name: 'Untitled video' }))
  const indexed = jobs.run({ kind: 'vision.index', title: 'Index', run: async () => 1 })
  await indexed.promise
  const cutout = jobs.run({
    kind: 'vision.cutout',
    title: 'Cutout',
    run: (ctx) =>
      new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))),
  })
  vi.mocked(set).mockClear()
  loadSample()
  expect(editor.getProject().songAssetId).toBeTruthy()
  // Cancelled before the sample replaced the project: the job is stopping at once.
  expect(jobs.list().find((j) => j.id === cutout.id)?.stopping).toBe(true)
  await cutout.promise.catch(() => undefined)
  expect(jobs.list().find((j) => j.id === cutout.id)?.status).toBe('cancelled')
  const update = vi
    .mocked(set)
    .mock.calls.map(([arg]) => arg)
    .find((arg) => typeof arg === 'function') as
    ((s: { dismissed: string[] }) => { dismissed: string[] }) | undefined
  expect(update?.({ dismissed: [] }).dismissed).toContain(indexed.id)
})

describe('with a Director draft that leaving the project would lose', () => {
  const holding = (held: boolean) =>
    holdDrafts({
      held: () => (held ? { kind: 'unapplied', unit: 'shot', made: 2, missing: 1 } : null),
      generating: () => false,
      apply: async () => false,
      show: () => undefined,
    })
  beforeEach(() => holding(true))
  afterEach(() => {
    holding(false)
    useLeaveDraft.setState({ ask: null, applying: false })
  })

  it('asks before Use a sample replaces the open project, and replaces it on Leave anyway', async () => {
    editor.load(createProject({ name: 'Untitled video' }))
    loadSample()
    expect(useLeaveDraft.getState().ask).not.toBeNull()
    expect(editor.getProject().name).toBe('Untitled video')
    await answerLeaveDraft('leave')
    expect(editor.getProject().songAssetId).toBeTruthy()
  })

  it('asks before a project file opens, and opens nothing when the user stays', async () => {
    editor.load(createProject({ name: 'Open' }))
    store.incoming = createProject({ name: 'Portable' })
    const staying = importProjectFile(projectFile)
    await vi.waitFor(() => expect(useLeaveDraft.getState().ask).not.toBeNull())
    await answerLeaveDraft('stay')
    await staying
    expect(store.opened).toEqual([])
    expect(editor.getProject().name).toBe('Open')

    const leaving = importProjectFile(projectFile)
    await vi.waitFor(() => expect(useLeaveDraft.getState().ask).not.toBeNull())
    await answerLeaveDraft('leave')
    await leaving
    expect(store.opened).toEqual(['Portable'])
    expect(editor.getProject().name).toBe('Portable')
  })
})
