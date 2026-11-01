import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = vi.hoisted(() => new Set<string>())

vi.mock('../../../src/app/state/persistence.ts', async () => {
  const { create } = await import('zustand')
  const usePersistence = create(() => ({ status: 'idle', restoring: false }))
  return {
    isStored: (id: string) => stored.has(id),
    // Like the real one, a link to another kept project restores it; the test ends that with `restoring: false`.
    openFromLink: () => usePersistence.setState({ restoring: true }),
    untracked: (run: () => void) => run(),
    usePersistence,
  }
})

/**
 * The parts of a page the hash sync uses, with its session history. Like a browser, setting the hash or going Back
 * only queues hashchange; `fire` runs it.
 */
function fakePage(hash: string) {
  const listeners: Record<string, (() => void)[]> = {}
  const toHash = (url: string) => url.slice(url.indexOf('#'))
  const entries = [hash]
  let index = 0
  const go = (value: string) => {
    entries.splice(index + 1, Infinity, value)
    index++
  }
  const pushes: string[] = []
  const window = {
    location: {
      get hash() {
        return entries[index] ?? ''
      },
      set hash(value: string) {
        go(value)
      },
    },
    history: {
      get length() {
        return entries.length
      },
      pushState: (_state: unknown, _unused: string, url: string) => {
        pushes.push(toHash(url))
        go(toHash(url))
      },
      replaceState: (_state: unknown, _unused: string, url: string) => {
        entries[index] = toHash(url)
      },
      back: () => (index = Math.max(0, index - 1)),
      forward: () => (index = Math.min(entries.length - 1, index + 1)),
    },
    addEventListener: (type: string, listener: () => void) => (listeners[type] ??= []).push(listener),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  return { window, pushes, fire: (type: string) => listeners[type]?.forEach((listener) => listener()) }
}

const query = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '')

async function start(hash: string) {
  const page = fakePage(hash)
  vi.stubGlobal('window', page.window)
  vi.resetModules()
  const { initHashSync } = await import('../../../src/app/state/hash.ts')
  const ui = await import('../../../src/app/state/ui.ts')
  const { editor, timelineDuration } = await import('../../../src/app/state/project.ts')
  const { usePersistence } = await import('../../../src/app/state/persistence.ts')
  initHashSync()
  return { page, ...ui, editor, timelineDuration, usePersistence }
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

  it('keeps the entry ahead when Back crosses a screen change, so Forward returns to it', async () => {
    const { page, get, set } = await start('')
    set({ screen: 'editor' })
    expect(page.pushes).toEqual(['#/editor'])

    page.window.history.back()
    page.fire('hashchange')
    expect(get().screen).toBe('start')
    expect(page.window.location.hash).toBe('#/start')
    expect(page.pushes).toEqual(['#/editor'])

    page.window.history.forward()
    page.fire('hashchange')
    expect(get().screen).toBe('editor')
    expect(page.window.location.hash).toBe('#/editor')
    expect(page.pushes).toEqual(['#/editor'])
  })

  it('writes a link to another kept project into the link’s own entry once the project opens', async () => {
    const { page, usePersistence, get } = await start('#/start')
    page.window.location.hash = '#/editor?project=kept'
    page.fire('hashchange')
    expect(get().screen).toBe('editor')
    usePersistence.setState({ restoring: false })
    expect(page.pushes).toEqual([])
    expect(page.window.history.length).toBe(2)
  })

  it('keeps the time on a hash change that names none, and moves to the one a hash names', async () => {
    const { page, get } = await start('#/editor?t=10')
    expect(get().playhead).toBe(10)
    page.window.location.hash = '#/editor?lib=text'
    page.fire('hashchange')
    expect(get().libraryTab).toBe('text')
    expect(get().playhead).toBe(10)
    page.window.location.hash = '#/editor?t=20'
    page.fire('hashchange')
    expect(get().playhead).toBe(20)
  })

  it('opens a link to a kept project at its start, where the sample opens at its chorus', async () => {
    const sample = await start('#/editor')
    expect(sample.get().playhead).toBeGreaterThan(0)

    const { page, get } = await start('#/editor?project=kept')
    expect(get().playhead).toBe(0)
    page.window.location.hash = '#/editor?t=10'
    page.fire('hashchange')
    expect(get().playhead).toBe(10)
    page.window.location.hash = '#/editor?project=other'
    page.fire('hashchange')
    expect(get().playhead).toBe(0)
  })

  it('keeps a link’s time within the timeline', async () => {
    const { page, get, editor, timelineDuration } = await start('#/editor?t=9999')
    const end = timelineDuration(editor.getProject())
    expect(end).toBeLessThan(9999)
    expect(get().playhead).toBe(end)
    page.window.location.hash = '#/editor?t=-5'
    page.fire('hashchange')
    expect(get().playhead).toBe(0)
  })
})
