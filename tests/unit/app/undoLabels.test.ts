import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  type Asset,
  type Project,
} from '../../../src/model/index.ts'
import { dispatch, editor, splitAtPlayhead, undo } from '../../../src/app/state/project.ts'
import { get, set, toast } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

const asset: Asset = {
  id: 'bee',
  kind: 'video',
  name: 'clip04_16x9_bee-lavender.mp4',
  mimeType: 'video/mp4',
  byteSize: 1,
  storageKey: 'bee',
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
}

/** Footage at 0-4 s (named by its file) and 4-8 s (named "Intro shot"), a text clip and a lyric line's chip. */
function scene() {
  const p: Project = createProject({ name: 'labels' })
  const footage = p.tracks[0]!
  const text = createTrack('visual', 'Text')
  p.tracks = [text, ...p.tracks]
  p.assets = { bee: asset }
  const a = createVideoClip({ trackId: footage.id, assetId: 'bee', start: 0, duration: 4 })
  const b = {
    ...createVideoClip({ trackId: footage.id, assetId: 'bee', start: 4, duration: 4 }),
    name: 'Intro shot',
  }
  const words = createTextClip({
    trackId: text.id,
    text: 'Hold on tonight, we run until the morning comes',
    start: 0,
    duration: 4,
  })
  const line = {
    ...createTextClip({ trackId: text.id, text: 'Say you will stay', start: 5, duration: 2 }),
    lyricLineId: 'l1',
  }
  for (const clip of [a, b, words, line]) p.clips[clip.id] = clip
  return { p, a, b, words, line }
}

let s: ReturnType<typeof scene>

beforeEach(() => {
  s = scene()
  editor.load(s.p)
  set({ selection: { type: 'none' }, playhead: 0, toasts: [] })
})

describe('undo labels of clip edits', () => {
  it('name the clip an edit without a label changes, as the timeline names it, and count several', () => {
    dispatch({ type: 'clip.move', moves: [{ clipId: s.a.id, start: 0.5 }] })
    expect(editor.undoLabel()).toBe('Move clip04_16x9_bee-lavender')
    dispatch({ type: 'clip.remove', clipIds: [s.b.id] })
    expect(editor.undoLabel()).toBe('Delete Intro shot')
    dispatch({ type: 'clip.trim', clipId: s.words.id, start: 0, duration: 3 })
    expect(editor.undoLabel()).toBe('Trim “Hold on tonight, we run until…”')
    dispatch({ type: 'clip.move', moves: [{ clipId: s.line.id, start: 5.5 }] })
    expect(editor.undoLabel()).toBe('Move “Say you will stay”')
    dispatch({
      type: 'clip.move',
      moves: [
        { clipId: s.a.id, start: 1 },
        { clipId: s.words.id, start: 1 },
      ],
    })
    expect(editor.undoLabel()).toBe('Move 2 clips')
  })

  it('keep a label the caller gave, and other edits keep the editor’s own', () => {
    dispatch({ type: 'clip.move', moves: [{ clipId: s.line.id, start: 5.5 }] }, { label: 'Nudge lyric line' })
    expect(editor.undoLabel()).toBe('Nudge lyric line')
    dispatch({ type: 'project.rename', name: 'Renamed' })
    expect(editor.undoLabel()).toBe('Rename project')
  })

  it('name the clip in a split, and in the toast after undo', () => {
    set({ playhead: 2, selection: { type: 'clip', id: s.a.id } })
    splitAtPlayhead()
    expect(editor.undoLabel()).toBe('Split clip04_16x9_bee-lavender')
    undo()
    expect(get().toasts.at(-1)?.message).toBe('Undid: Split clip04_16x9_bee-lavender')
  })
})

describe('a toast’s Undo', () => {
  const noop = () => {}
  const shown = () => get().toasts.map((t) => ({ message: t.message, undo: !!t.action, show: !!t.show }))

  it('goes once another edit, an undo or a redo makes its edit no longer the last; Show stays', () => {
    dispatch({ type: 'clip.move', moves: [{ clipId: s.a.id, start: 0.5 }] })
    toast('Moved the clip', { label: 'Undo', run: noop })
    toast('Made 2 images', { label: 'Undo', run: noop }, { show: noop })
    // A background write leaves no undo step, so the edit is still the last.
    dispatch({ type: 'project.rename', name: 'Analyzed' }, { history: 'skip' })
    expect(shown()).toEqual([
      { message: 'Moved the clip', undo: true, show: false },
      { message: 'Made 2 images', undo: true, show: true },
    ])

    dispatch({ type: 'clip.remove', clipIds: [s.b.id] })
    expect(shown()).toEqual([{ message: 'Made 2 images', undo: false, show: true }])

    toast('Deleted Intro shot', { label: 'Undo', run: noop })
    undo()
    expect(shown().map((t) => t.message)).toEqual(['Made 2 images', 'Undid: Delete Intro shot'])
  })
})
