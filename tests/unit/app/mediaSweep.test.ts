import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { olderTabsGone } from '../../../src/app/state/persistence.ts'

const DAY = 24 * 60 * 60 * 1000
const first = Date.UTC(2026, 10, 1)

beforeEach(() => {
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('lets the startup sweep run only three days after this build first started in the browser', () => {
  expect(olderTabsGone(first)).toBe(false)
  expect(olderTabsGone(first + DAY)).toBe(false)
  expect(olderTabsGone(first + 3 * DAY - 1)).toBe(false)
  expect(olderTabsGone(first + 3 * DAY)).toBe(true)
  expect(olderTabsGone(first + 30 * DAY)).toBe(true)
})

it('never lets it run when localStorage is unavailable', () => {
  const denied = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
  expect(olderTabsGone(first)).toBe(false)
  expect(olderTabsGone(first + 30 * DAY)).toBe(false)
})
