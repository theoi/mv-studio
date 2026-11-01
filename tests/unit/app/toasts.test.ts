import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, get, set, setSnap, toast } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => {
  vi.useFakeTimers()
  set({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

const messages = () => get().toasts.map((t) => t.message)
const noop = () => {}

describe('toasts', () => {
  it('lets a note go after about 5 s, and one with a button only after 20 s', () => {
    toast('Sample project loaded')
    toast('Moved 1 clip', { label: 'Undo', run: noop })
    vi.advanceTimersByTime(6_000)
    expect(messages()).toEqual(['Moved 1 clip'])
    vi.advanceTimersByTime(13_000)
    expect(messages()).toEqual(['Moved 1 clip'])
    vi.advanceTimersByTime(2_000)
    expect(messages()).toEqual([])
  })

  it('keeps an offer until it is dismissed, while newer toasts push out older ones', () => {
    const offer = 'Switched to 9:16. Keep subjects in frame?'
    toast(offer, { label: 'Reframe automatically', run: noop }, { sticky: true })
    for (const note of ['One', 'Two', 'Three', 'Four']) toast(note)
    expect(messages()).toEqual([offer, 'Two', 'Three', 'Four'])
    vi.advanceTimersByTime(60_000)
    expect(messages()).toEqual([offer])
    dismissToast(get().toasts[0]!.id)
    expect(messages()).toEqual([])
  })
})

describe('snapping', () => {
  it('says each change in one toast, and the choices last to the next visit', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    setSnap('snap', false)
    expect(messages()).toEqual(['Snapping off'])
    setSnap('edgeSnap', false)
    expect(messages()).toEqual(['Snapping to clip edges off'])
    // Changed anywhere else (Settings › Editing), the choice is kept too.
    set({ barSnap: false })

    vi.resetModules()
    const next = await import('../../../src/app/state/ui.ts')
    expect(next.get()).toMatchObject({
      snap: false,
      beatSnap: true,
      barSnap: false,
      sectionSnap: true,
      edgeSnap: false,
      playheadSnap: true,
    })
  })
})
