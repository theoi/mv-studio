import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { changeAspect, lastingOffer, reframeProject } from '../../../src/app/state/reframe.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => {
  loadDemoProject()
  set({ toasts: [] })
})

const offers = () =>
  get()
    .toasts.filter((t) => t.action?.label === 'Reframe automatically' || t.action?.label === 'Restore layout')
    .map((t) => ({ message: t.message, sticky: t.sticky }))

describe('the offer to reframe after a frame change', () => {
  it('stays on screen, and Inspector › Project offers it as long as the clips are laid out for the old frame', () => {
    changeAspect('9:16')
    expect(offers()).toEqual([{ message: 'Switched to 9:16. Keep subjects in frame?', sticky: true }])
    expect(lastingOffer(editor.getProject())).toEqual({
      note: 'The clips are still laid out for 16:9.',
      label: 'Reframe automatically',
    })
  })

  it('goes once it no longer applies: the frame change undone, or the offer taken elsewhere', () => {
    changeAspect('9:16')
    editor.undo()
    expect(offers()).toEqual([])
    expect(lastingOffer(editor.getProject())).toBeNull()

    changeAspect('9:16')
    reframeProject()
    expect(offers()).toEqual([])
    expect(lastingOffer(editor.getProject())).toBeNull()

    // Back in 16:9, the clips remember their layout there.
    changeAspect('16:9')
    expect(offers()).toEqual([{ message: 'Back to 16:9. Restore the 16:9 layout?', sticky: true }])
    expect(lastingOffer(editor.getProject())).toEqual({
      note: 'The clips can go back to their 16:9 layout.',
      label: 'Restore layout',
    })
  })
})
