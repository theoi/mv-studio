import { beforeEach, expect, it, vi } from 'vitest'
import { cancelPick, pickAt, startPick, usePick } from '../../../src/app/state/pick.ts'
import { loadDemoProject } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeEach(() => {
  cancelPick()
  set({ screen: 'editor', playing: false, dialog: null, paletteOpen: false, guideStep: null, playhead: 12 })
})

it('pauses playback, then takes one point at the playhead and leaves pick mode', () => {
  set({ playing: true })
  const onPick = vi.fn()
  const onCancel = vi.fn()
  startPick({ prompt: 'Click the object', onPick, onCancel })
  expect(get().playing).toBe(false)
  expect(usePick.getState().request?.prompt).toBe('Click the object')

  pickAt(1.4, 0.25)
  expect(onPick).toHaveBeenCalledExactlyOnceWith({ x: 1, y: 0.25, time: 12 })
  expect(usePick.getState().request).toBeNull()
  pickAt(0.5, 0.5)
  expect(onPick).toHaveBeenCalledOnce()
  expect(onCancel).not.toHaveBeenCalled()
})

it.each([
  ['playback starts', () => set({ playing: true })],
  ['a dialog opens', () => set({ dialog: 'export' })],
  ['the command palette opens', () => set({ paletteOpen: true })],
  ['the guide opens', () => set({ guideStep: 0 })],
  ['the screen changes', () => set({ screen: 'start' })],
  ['another project loads', () => loadDemoProject()],
])('is cancelled when %s', (_when, act) => {
  const onPick = vi.fn()
  const onCancel = vi.fn()
  startPick({ prompt: 'Click the object', onPick, onCancel })
  act()
  expect(onCancel).toHaveBeenCalledOnce()
  expect(usePick.getState().request).toBeNull()
  expect(onPick).not.toHaveBeenCalled()
})

it('stays on for unrelated changes such as moving the playhead', () => {
  const onCancel = vi.fn()
  startPick({ prompt: 'Click the object', onPick: vi.fn(), onCancel })
  set({ playhead: 20, selection: { type: 'none' } })
  expect(onCancel).not.toHaveBeenCalled()
  expect(usePick.getState().request).not.toBeNull()
})

it('cancels a pick in progress when another starts, and lets onPick start the next one', () => {
  const firstCancel = vi.fn()
  startPick({ prompt: 'First', onPick: vi.fn(), onCancel: firstCancel })
  const next = { prompt: 'Again', onPick: vi.fn() }
  const secondCancel = vi.fn()
  startPick({ prompt: 'Second', onPick: () => startPick(next), onCancel: secondCancel })
  expect(firstCancel).toHaveBeenCalledOnce()

  pickAt(0.2, 0.3)
  expect(secondCancel).not.toHaveBeenCalled()
  expect(usePick.getState().request).toBe(next)
})
