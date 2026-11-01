import { beforeEach, expect, it, vi } from 'vitest'
import { createProject, type Project } from '../../../src/model/index.ts'
import { duplicateProject, refreshRecents } from '../../../src/app/state/persistence.ts'
import { editor } from '../../../src/app/state/project.ts'

const store = vi.hoisted(() => ({ kept: new Map<string, Project>(), saved: [] as string[] }))

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
  IdbProjectStore: class {
    async list() {
      return [...store.kept.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
    }
    async load(id: string) {
      return store.kept.get(id)
    }
    async save(project: Project) {
      store.saved.push(project.name)
      store.kept.set(project.id, project)
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
})

it('numbers a copy from (2) even when no project has the name without the number', async () => {
  // The original "Neon Skyline" was deleted; only its copy is kept.
  const copy = keep('Neon Skyline (2)')
  editor.load(createProject({ name: 'Untitled video' }))
  await refreshRecents()
  expect((await duplicateProject(copy.id)).name).toBe('Neon Skyline (3)')
})

it('takes no name the open project has, kept or not', async () => {
  const kept = keep('Neon Skyline (2)')
  editor.load(createProject({ name: 'Neon Skyline (3)' }))
  await refreshRecents()
  expect((await duplicateProject(kept.id)).name).toBe('Neon Skyline (4)')
  expect(store.saved).toEqual(['Neon Skyline (4)'])
})
