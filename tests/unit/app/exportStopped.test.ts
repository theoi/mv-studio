import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  exportResolution,
  exportStoppedMessage,
  findStoppedExport,
  markExportRunning,
  useStoppedExport,
} from '../../../src/app/state/exports.ts'
import { exportSize } from '../../../src/engine/export.ts'

const LOWER = /Try a lower resolution\.$/
const CLOSE_TABS = /Close other tabs and try again\.$/
const MARK = 'mv-studio.export-running'

describe('the advice after an export stopped', () => {
  it.each([
    ['a 720p Full video', [exportSize('16:9', '720p')], CLOSE_TABS],
    ['a 720p Vertical, 720 × 1280', [exportSize('9:16', '720p')], CLOSE_TABS],
    ['a 720p 4:5 output, 720 × 900', [exportSize('4:5', '720p')], CLOSE_TABS],
    ['a 1080p Vertical', [exportSize('9:16', '1080p')], LOWER],
    [
      'a 720p Full video with a 1080p Vertical',
      [exportSize('16:9', '720p'), exportSize('9:16', '1080p')],
      LOWER,
    ],
  ])('for %s goes by the resolution, the short side', (_, sizes, advice) => {
    expect(exportStoppedMessage(exportResolution(sizes))).toMatch(advice)
  })
})

describe('without Web Locks', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks no export and reports none, since an export running in another tab would look stopped', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('navigator', {})
    markExportRunning(1080, { id: 'p', name: 'Night drive', kept: true }, new Promise(() => undefined))
    expect(stored.size).toBe(0)

    stored.set(MARK, JSON.stringify({ resolution: 1080, lock: 'mv-studio.export:in-another-tab' }))
    expect(await findStoppedExport()).toBeNull()
    expect(stored.has(MARK)).toBe(true)
    expect(useStoppedExport.getState().stopped).toBeNull()
  })
})

describe('an export of several files that stopped', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says how many of them were saved, so they aren’t exported again', () => {
    expect(exportStoppedMessage(720, undefined, { saved: 1, total: 2 })).toBe(
      'The last export didn’t finish. 1 of 2 files was saved to Downloads. The browser may have run out of memory. Close other tabs and try again.',
    )
    expect(exportStoppedMessage(1080, 'Night drive', { saved: 2, total: 3 })).toBe(
      'The export of “Night drive” didn’t finish. 2 of 3 files were saved to Downloads. The browser may have run out of memory. Try a lower resolution.',
    )
  })

  it('keeps the count of saved files in its mark, where the next visit finds it', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
    // No lock is held at the next visit: the tab that ran the export died.
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, run: () => unknown) => run(),
        query: async () => ({ held: [] }),
      },
    })
    const saved = markExportRunning(
      720,
      { id: 'p', name: 'Night drive', kept: true },
      new Promise(() => undefined),
      2,
    )
    await vi.waitFor(() => expect(stored.has(MARK)).toBe(true))
    saved(1)
    const stopped = await findStoppedExport()
    expect(stopped?.files).toEqual({ saved: 1, total: 2 })
  })
})
