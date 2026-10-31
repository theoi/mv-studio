import { afterEach, describe, expect, it, vi } from 'vitest'
import { firstHalfSpecs } from '../../playwright.config.ts'

describe('the two CI halves of the E2E suite', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deal specs with the same time to the same half whatever the machine locale', () => {
    const timings = { 'load-errors.spec.ts': 16, 'lyric-checks.spec.ts': 16 }
    const specs = ['lyric-checks.spec.ts', 'load-errors.spec.ts']
    const dealt = ['en', 'lt'].map((locale) => {
      // The process locale picks localeCompare's collation. Lithuanian sorts y with i, so "lyric" comes before "load".
      const collator = new Intl.Collator(locale)
      vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, that: string) {
        return collator.compare(this, that)
      })
      const first = firstHalfSpecs(timings, specs)
      vi.restoreAllMocks()
      return first
    })
    expect(dealt[0]).toHaveLength(1)
    expect(dealt[1]).toEqual(dealt[0])
  })
})
