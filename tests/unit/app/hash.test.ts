import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = vi.hoisted(() => new Set<string>())

vi.mock('../../../src/app/state/persistence.ts', async () => {
  const { create } = await import('zustand')
  return {
    isStored: (id: string) => stored.has(id),
    openFromLink: vi.fn(),
    untracked: (run: () => void) => run(),
    usePersistence: create(() => ({ status: 'idle', restoring: false })),
  }
})

/** The parts of a page the hash sync uses. Like a browser, setting the hash only queues hashchange; `fire` runs it. */
function fakePage(hash: string) {
  const listeners: Record<string, (() => void)[]> = {}
  const toHash = (url: string) => url.slice(url.indexOf('#'))
  const window = {
    location: { hash },
    history: {
      pushState: (_state: unknown, _unused: string, url: string) => (window.location.hash = toHash(url)),
      replaceState: (_state: unknown, _unused: string, url: string) => (window.location.hash = toHash(url)),
    },
    addEventListener: (type: string, listener: () => void) => (listeners[type] ??= []).push(listener),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  return { window, fire: (type: string) => listeners[type]?.forEach((listener) => listener()) }
}

const query = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '')

async function start(hash: string) {
  const page = fakePage(hash)
  vi.stubGlobal('window', page.window)
  vi.resetModules()
  const { initHashSync } = await import('../../../src/app/state/hash.ts')
  const ui = await import('../../../src/app/state/ui.ts')
  const { editor } = await import('../../../src/app/state/project.ts')
  const { usePersistence } = await import('../../../src/app/state/persistence.ts')
  initHashSync()
  return { page, ...ui, editor, usePersistence }
}

beforeEach(() => {
  stored.clear()
  vi.unstubAllGlobals()
})

describe('the URL hash and the app state', () => {
  it('writes UI changes to the hash after a link opened the editor with values that are not written back', async () => {
    const { page, set } = await start('#/editor?t=5')
    set({ libraryTab: 'text' })
    expect(query(page.window.location.hash).get('lib')).toBe('text')
  })

  it('applies a link followed just as autosave first keeps the project, and then names the project', async () => {
    const { page, editor, usePersistence, get, set } = await start('#/editor')
    const id = editor.getProject().id
    const clip = Object.keys(editor.getProject().clips)[0]!
    // A link or the address bar changes the hash; the browser runs hashchange in a later task.
    page.window.location.hash = `#/editor?sel=clip:${clip}&t=10`
    // Before it runs, the first autosave keeps the project, so the hash would gain the project's id.
    stored.add(id)
    usePersistence.setState({ status: 'saved' })
    page.fire('hashchange')

    expect(get().selection).toEqual({ type: 'clip', id: clip })
    expect(get().playhead).toBe(10)
    expect(query(page.window.location.hash).get('project')).toBe(id)
    expect(query(page.window.location.hash).get('sel')).toBe(`clip:${clip}`)
    set({ selection: { type: 'none' } })
    expect(query(page.window.location.hash).get('sel')).toBeNull()
  })
})
