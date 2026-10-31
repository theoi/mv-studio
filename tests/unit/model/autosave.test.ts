import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAutosave } from '../../../src/model/autosave.ts'
import { ProjectEditor } from '../../../src/model/editor.ts'
import { createProject } from '../../../src/model/factory.ts'
import type { Project } from '../../../src/model/types.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('autosave', () => {
  it('debounces bursts of edits into one save of the latest project', async () => {
    const editor = new ProjectEditor(createProject())
    const saved: Project[] = []
    const autosave = startAutosave(editor, async (p) => void saved.push(p), { delayMs: 500 })
    editor.dispatch({ type: 'project.rename', name: 'A' })
    editor.dispatch({ type: 'project.rename', name: 'B' })
    expect(autosave.getState().status).toBe('pending')
    await vi.advanceTimersByTimeAsync(499)
    expect(saved).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saved.map((p) => p.name)).toEqual(['B'])
    expect(autosave.getState().status).toBe('saved')
    autosave.stop()
  })

  it('saves at least every maxDelayMs during continuous editing', async () => {
    const editor = new ProjectEditor(createProject())
    const save = vi.fn(async () => undefined)
    const autosave = startAutosave(editor, save, { delayMs: 500, maxDelayMs: 1200 })
    for (let i = 0; i < 6; i++) {
      editor.dispatch({ type: 'project.rename', name: `n${i}` })
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(save).toHaveBeenCalledTimes(1)
    autosave.stop()
  })

  it('reports errors and retries on the next change', async () => {
    const editor = new ProjectEditor(createProject())
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const autosave = startAutosave(editor, save, { delayMs: 100 })
    editor.dispatch({ type: 'project.rename', name: 'x' })
    await vi.advanceTimersByTimeAsync(100)
    expect(autosave.getState()).toMatchObject({ status: 'error', error: 'disk full' })
    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(autosave.getState().status).toBe('saved')
    autosave.stop()
  })

  it('does not save when a project is loaded', async () => {
    const editor = new ProjectEditor(createProject())
    const save = vi.fn(async () => undefined)
    const autosave = startAutosave(editor, save, { delayMs: 100 })
    editor.load(createProject())
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    autosave.stop()
  })

  it('when the page hides during a save, writes the latest project at once instead of waiting behind it', async () => {
    const editor = new ProjectEditor(createProject())
    const calls: { name: string; leaving: boolean; finish: () => void }[] = []
    const save = (p: Project, { leaving }: { leaving: boolean }) =>
      new Promise<void>((resolve) => calls.push({ name: p.name, leaving, finish: resolve }))
    const target = new EventTarget()
    const autosave = startAutosave(editor, save, { delayMs: 100, target })
    editor.dispatch({ type: 'project.rename', name: 'A' })
    await vi.advanceTimersByTimeAsync(100)
    // The first save is still running (making its thumbnail, say) when the user edits again and closes the tab.
    editor.dispatch({ type: 'project.rename', name: 'B' })
    target.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map(({ name, leaving }) => ({ name, leaving }))).toEqual([
      { name: 'A', leaving: false },
      { name: 'B', leaving: true },
    ])
    calls[1]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(autosave.getState().status).toBe('saved')
    // The older save finishing later doesn't change what the status says.
    calls[0]!.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(autosave.getState()).toMatchObject({ status: 'saved' })
    await autosave.flush({ leaving: true })
    expect(calls).toHaveLength(2)
    autosave.stop()
  })

  it('ignores an older save failing after a newer one saved everything it had', async () => {
    const editor = new ProjectEditor(createProject())
    const calls: { resolve: () => void; reject: (e: Error) => void }[] = []
    const save = () => new Promise<void>((resolve, reject) => calls.push({ resolve, reject }))
    const target = new EventTarget()
    const autosave = startAutosave(editor, save, { delayMs: 100, target })
    editor.dispatch({ type: 'project.rename', name: 'A' })
    await vi.advanceTimersByTimeAsync(100)
    editor.dispatch({ type: 'project.rename', name: 'B' })
    // The user cancels the leave prompt: the page stays, with both saves running.
    target.dispatchEvent(new Event('pagehide'))
    calls[1]!.resolve()
    await vi.advanceTimersByTimeAsync(0)
    calls[0]!.reject(new Error('disk full'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(autosave.getState()).toEqual(expect.objectContaining({ status: 'saved', error: undefined }))
    expect(calls).toHaveLength(2)
    autosave.stop()
  })

  it('writes the project once when a tab closes (beforeunload, visibilitychange and pagehide)', async () => {
    const editor = new ProjectEditor(createProject())
    const saved: boolean[] = []
    const save = (_p: Project, { leaving }: { leaving: boolean }) =>
      new Promise<void>((resolve) => {
        saved.push(leaving)
        setTimeout(resolve, 50)
      })
    const target = new EventTarget()
    const autosave = startAutosave(editor, save, { delayMs: 100, target })
    editor.dispatch({ type: 'project.rename', name: 'A' })
    void autosave.flush({ leaving: true })
    target.dispatchEvent(new Event('visibilitychange'))
    target.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved).toEqual([true])
    expect(autosave.getState().status).toBe('saved')
    autosave.stop()
  })

  it('saves derived writes that skip the undo history', async () => {
    const editor = new ProjectEditor(createProject())
    const saved: Project[] = []
    const autosave = startAutosave(editor, async (p) => void saved.push(p), { delayMs: 100 })
    editor.dispatch(
      { type: 'analysis.setVisual', analysis: { assetId: 'a', version: 'test', data: { v: 1 } } },
      { history: 'skip' },
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(saved.map((p) => p.analysis.visual.a?.data)).toEqual([{ v: 1 }])
    expect(editor.canUndo()).toBe(false)
    autosave.stop()
  })
})
