import { beforeEach, expect, it, vi } from 'vitest'
import type { KeyCheck } from '../../../src/cloud/types.ts'
import { CloudError } from '../../../src/cloud/errors.ts'
import { cloudSettings, connectFalKey, typeFalKey, useFalKeyEntry } from '../../../src/app/state/cloud.ts'

const checks = vi.hoisted(() => ({ next: [] as ((check: KeyCheck) => void)[] }))

vi.mock('../../../src/cloud/fal/provider.ts', () => ({
  FalProvider: class {
    validateKey(): Promise<KeyCheck> {
      return new Promise((resolve) => checks.next.push(resolve))
    }
  },
}))

const noAnswer = new CloudError({
  kind: 'timeout',
  provider: 'fal',
  title: 'fal.ai didn’t answer',
  message: 'No answer',
})

beforeEach(() => {
  checks.next.length = 0
  cloudSettings.setFalKey('')
  useFalKeyEntry.setState({ draft: '', checking: false, error: null })
})

it('keeps the typed key and why its check failed, and saves it once a check passes', async () => {
  typeFalKey('key-id:key-secret')
  const first = connectFalKey()
  expect(useFalKeyEntry.getState().checking).toBe(true)
  await vi.waitFor(() => expect(checks.next).toHaveLength(1))
  checks.next[0]?.({ ok: false, error: noAnswer })
  expect(await first).toBe(false)
  expect(useFalKeyEntry.getState()).toMatchObject({
    draft: 'key-id:key-secret',
    checking: false,
    error: noAnswer,
  })
  expect(cloudSettings.get().falKey).toBe('')

  const second = connectFalKey()
  expect(useFalKeyEntry.getState()).toMatchObject({ checking: true, error: null })
  await vi.waitFor(() => expect(checks.next).toHaveLength(2))
  checks.next[1]?.({ ok: true, message: 'fal.ai accepted the key.' })
  expect(await second).toBe(true)
  expect(cloudSettings.get().falKey).toBe('key-id:key-secret')
  expect(useFalKeyEntry.getState()).toMatchObject({ draft: '', checking: false, error: null })
})

it('drops a check whose key was changed while it ran, and runs one check at a time', async () => {
  typeFalKey('key-id:first')
  const check = connectFalKey()
  expect(await connectFalKey()).toBe(false)
  await vi.waitFor(() => expect(checks.next).toHaveLength(1))
  typeFalKey('key-id:second')
  checks.next[0]?.({ ok: true, message: 'fal.ai accepted the key.' })
  expect(await check).toBe(false)
  expect(cloudSettings.get().falKey).toBe('')
  expect(useFalKeyEntry.getState()).toMatchObject({ draft: 'key-id:second', checking: false, error: null })
})
