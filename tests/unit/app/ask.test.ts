import { beforeEach, expect, it, vi } from 'vitest'
import { ask, useAsk } from '../../../src/app/state/ask.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { createProject } from '../../../src/model/factory.ts'

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })
  loadDemoProject()
  useAsk.setState({ state: { status: 'idle' } })
})

it('takes a request in the open project: without an AI model, it says one is needed', async () => {
  await ask('dim all the footage')
  expect(useAsk.getState().state).toMatchObject({ status: 'error', needsSetup: true })
})

it('drops a request typed in the project that was open when Ask started loading', async () => {
  const asking = ask('dim all the footage')
  editor.load(createProject({ name: 'Other', fps: 30 }))
  await asking
  expect(useAsk.getState().state).toEqual({ status: 'idle' })
})
