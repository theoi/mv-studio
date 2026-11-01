import { beforeEach, expect, it, vi } from 'vitest'
import { createProject, type Project } from '../../../src/model/index.ts'
import {
  chooseSameProject,
  duplicateProject,
  importProjectFile,
  refreshRecents,
  usePersistence,
} from '../../../src/app/state/persistence.ts'
import { toast } from '../../../src/app/state/ui.ts'
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
