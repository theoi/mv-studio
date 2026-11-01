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
