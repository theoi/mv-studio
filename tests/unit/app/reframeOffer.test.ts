import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { changeAspect, framingHint, lastingOffer, reframeProject } from '../../../src/app/state/reframe.ts'
import { get, set } from '../../../src/app/state/ui.ts'
import type { VisualClip } from '../../../src/model/index.ts'
import type * as Capabilities from '../../../src/shared/capabilities.ts'

const gpu = vi.hoisted(() => ({ webgl2: true }))
vi.mock('../../../src/shared/capabilities.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Capabilities>()),
  webgl2Available: () => gpu.webgl2,
}))

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => {
  loadDemoProject()
  set({ toasts: [] })
})

afterEach(() => {
  gpu.webgl2 = true
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

describe('footage kept centered for lack of subject analysis', () => {
  // The sample's footage has no subject analysis.
  const footage = () => {
    const clips = Object.values(editor.getProject().clips)
    const id = clips.find((c) => c.type === 'video')!.id
    return () => editor.getProject().clips[id] as VisualClip
  }
  const results = () =>
    get()
      .toasts.filter((t) => t.action?.label === 'Undo')
      .map((t) => t.message)

  it('says the analysis is still to come where it can run', () => {
    const clip = footage()
    expect(framingHint(editor.getProject(), clip())).toBe(
      'Other aspect ratios keep it centered: it has no subject analysis yet.',
    )
    changeAspect('9:16')
    reframeProject()
    expect(results()).toEqual([
      expect.stringMatching(/ · \d+ clips stay centered \(no subject analysis yet\)$/),
    ])
    expect(framingHint(editor.getProject(), clip())).toBe(
      'Reframed from 16:9 and kept centered: it has no subject analysis yet.',
    )
  })

  it('says following subjects needs graphics acceleration where WebGL 2 is missing, since no analysis will come', () => {
    gpu.webgl2 = false
    const clip = footage()
    expect(framingHint(editor.getProject(), clip())).toBe(
      'Other aspect ratios keep it centered: following its subject needs graphics acceleration (WebGL 2).',
    )
    changeAspect('9:16')
    reframeProject()
    expect(results()).toEqual([
      expect.stringMatching(
        / · \d+ clips stay centered, since following subjects needs graphics acceleration \(WebGL 2\)$/,
      ),
    ])
    expect(framingHint(editor.getProject(), clip())).toBe(
      'Reframed from 16:9 and kept centered: following its subject needs graphics acceleration (WebGL 2).',
    )
  })
})
