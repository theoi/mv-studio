import { expect, it, vi } from 'vitest'
import { connectFalKey, typeFalKey, useFalKeyEntry } from '../../../src/app/state/cloud.ts'

vi.mock('../../../src/cloud/fal/provider.ts', () => {
  throw new TypeError('Failed to fetch dynamically imported module')
})

it('says it could not reach fal.ai when the code that checks the key does not load, instead of checking forever', async () => {
  typeFalKey('key-id:key-secret')
  expect(await connectFalKey()).toBe(false)
  expect(useFalKeyEntry.getState()).toMatchObject({
    draft: 'key-id:key-secret',
    checking: false,
    error: { kind: 'network', title: "Couldn't reach fal.ai" },
  })
})
