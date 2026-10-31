import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createImageClip,
  createProject,
  createTextClip,
  createTrack,
  createVideoClip,
  type Asset,
  type Project,
  type TextClip,
} from '../../../src/model/index.ts'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  paste,
  pasteAt,
  pasteHereOutcome,
  selectAll,
  selectTimelineClips,
  timelineSelectionIds,
} from '../../../src/app/state/clipboard.ts'
import { editor, splitAtPlayhead } from '../../../src/app/state/project.ts'
import { get, selectClips, selectedClipIds, set } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

const asset = (id: string, kind: Asset['kind']): Asset => ({
  id,
  kind,
  name: id,
  mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  byteSize: 1,
  storageKey: id,
  origin: { type: 'import' },
  createdAt: new Date(0).toISOString(),
})

/** Footage at 0-4, 4-8, 8-11 and 14-18 s; a lyric line; a locked track with an image at 0-3 s. */
function scene() {
  const p: Project = createProject({ name: 'clipboard' })
  const footage = { ...p.tracks[0]!, name: 'Footage' }
  const lyrics = createTrack('visual', 'Lyrics')
  const locked = { ...createTrack('visual', 'Locked'), locked: true }
  p.tracks = [lyrics, locked, footage, ...p.tracks.slice(1)]
  p.assets = { v: asset('v', 'video'), i: asset('i', 'image') }
  const a = createVideoClip({ trackId: footage.id, assetId: 'v', start: 0, duration: 4 })
  const b = createImageClip({ trackId: footage.id, assetId: 'i', start: 4, duration: 4 })
  const c = createVideoClip({ trackId: footage.id, assetId: 'v', start: 8, duration: 3 })
  const d = createVideoClip({ trackId: footage.id, assetId: 'v', start: 14, duration: 4 })
  const top = createImageClip({ trackId: locked.id, assetId: 'i', start: 0, duration: 3 })
  const line = {
    ...createTextClip({ trackId: lyrics.id, text: 'Hello', start: 0, duration: 4 }),
    lyricLineId: 'l1',
  }
  for (const clip of [a, b, c, d, top, line]) p.clips[clip.id] = clip
  return { p, footage, locked, a, b, c, d, top, line }
}

let s: ReturnType<typeof scene>

beforeEach(() => {
  s = scene()
  editor.load(s.p)
  set({ selection: { type: 'none' }, playhead: 0 })
})

const project = () => editor.getProject()
const onTrack = (trackId: string) =>
  Object.values(project().clips)
    .filter((c) => c.trackId === trackId)
    .sort((x, y) => x.start - y.start)
    .map((c) => [c.start, c.duration])
const selected = () => selectedClipIds(get().selection).map((id) => project().clips[id])

describe('copy and paste', () => {
  it('pastes at the playhead on the same track, keeping the spacing, as one undo step that selects the copies', () => {
    selectClips([s.a.id, s.c.id])
    expect(copySelection()).toBe(true)
    set({ playhead: 20 })
    paste()
    expect(onTrack(s.footage.id)).toEqual([
      [0, 4],
      [4, 4],
      [8, 3],
      [14, 4],
      [20, 4],
      [28, 3],
    ])
    const copies = selected()
    expect(copies.map((c) => c?.start)).toEqual([20, 28])
    expect(copies.every((c) => c && c.id !== s.a.id && c.id !== s.c.id)).toBe(true)
    expect(editor.undoLabel()).toBe('Paste 2 clips')
    editor.undo()
    expect(onTrack(s.footage.id)).toHaveLength(4)
  })

  it('puts the copies on a new numbered track like the source, above it, when the source track is taken there', () => {
    selectClips([s.a.id, s.c.id])
    copySelection()
    set({ playhead: 2 })
    paste()
    const tracks = project().tracks
    const index = tracks.findIndex((t) => t.id === s.footage.id)
    const added = tracks[index - 1]!
    expect(added).toMatchObject({ kind: 'visual', name: 'Footage 2', locked: false })
    expect(added.id).not.toBe(s.locked.id)
    expect(onTrack(added.id)).toEqual([
      [2, 4],
      [10, 3],
    ])
    expect(onTrack(s.footage.id)).toHaveLength(4)
    editor.undo()
    expect(project().tracks.map((t) => t.id)).toEqual(s.p.tracks.map((t) => t.id))
  })

  it('pastes into another project with the assets the clips use, on a new track named like the source', () => {
    selectClips([s.d.id])
    copySelection()
    const other = createProject({ name: 'other' })
    editor.load(other)
    set({ playhead: 1, selection: { type: 'none' } })
    paste()
    const p = project()
    expect(p.assets.v).toMatchObject({ id: 'v', kind: 'video' })
    const added = p.tracks.find((t) => t.name === 'Footage')!
    expect(added.kind).toBe('visual')
    expect(onTrack(added.id)).toEqual([[1, 4]])
  })

  it('copies nothing without selected clips, and lyric lines are not clips to select all', () => {
    expect(copySelection()).toBe(false)
    set({ selection: { type: 'lyric', id: 'l1' } })
    expect(copySelection()).toBe(false)
  })
})

describe('Paste here (the lane menu)', () => {
  it('pastes at the right-clicked time on the right-clicked track when it can take the clips, and selects them', () => {
    selectClips([s.a.id, s.c.id])
    copySelection()
    const overlay = createTrack('visual', 'Overlay')
    editor.dispatch({ type: 'track.add', track: overlay, index: 0 })
    expect(pasteHereOutcome(project(), overlay.id, 2)).toBe('here')
    pasteAt(overlay.id, 2)
    expect(onTrack(overlay.id)).toEqual([
      [2, 4],
      [10, 3],
    ])
    expect(selected().map((c) => c?.trackId)).toEqual([overlay.id, overlay.id])
    expect(editor.undoLabel()).toBe('Paste 2 clips')
    editor.undo()
    expect(onTrack(overlay.id)).toEqual([])
  })

  it('keeps the usual paste rules where the track is taken or locked, is the lyrics lane, or the clips come from several tracks, and says where they land', () => {
    selectClips([s.a.id])
    copySelection()
    const lyrics = project().tracks.find((t) => t.name === 'Lyrics')!
    expect(pasteHereOutcome(project(), s.footage.id, 20)).toBe('here')
    // Footage, the clip's own track, is taken at 2 s, so the copy goes on a new track.
    expect(pasteHereOutcome(project(), s.footage.id, 2)).toBe('new')
    expect(pasteHereOutcome(project(), s.locked.id, 2)).toBe('new')
    expect(pasteHereOutcome(project(), lyrics.id, 2)).toBe('new')
    expect(pasteHereOutcome(project(), s.locked.id, 20)).toBe('own')
    expect(pasteHereOutcome(project(), lyrics.id, 20)).toBe('own')
    pasteAt(s.locked.id, 2)
    const added = project().tracks.find((t) => t.name === 'Footage 2')!
    expect(onTrack(added.id)).toEqual([[2, 4]])
    pasteAt(lyrics.id, 20)
    expect(onTrack(s.footage.id)).toContainEqual([20, 4])

    // From two tracks: the footage goes back on Footage, and the locked track's image needs a new track.
    selectClips([s.a.id, s.top.id])
    copySelection()
    expect(pasteHereOutcome(project(), s.footage.id, 30)).toBe('mixed')
    expect(pasteHereOutcome(project(), s.footage.id, 2)).toBe('new-tracks')
    const before = project().tracks.length
    pasteAt(s.footage.id, 2)
    expect(project().tracks.length).toBe(before + 2)
  })
})

describe('duplicate, cut and delete', () => {
  it('duplicates right after the selection, on a new track when the space after it is taken', () => {
    selectClips([s.d.id])
    expect(duplicateSelection()).toBe(true)
    expect(onTrack(s.footage.id).at(-1)).toEqual([18, 4])
    expect(editor.undoLabel()).toBe('Duplicate clip')
    expect(selected().map((c) => c?.start)).toEqual([18])

    selectClips([s.b.id])
    duplicateSelection()
    const above = project().tracks[project().tracks.findIndex((t) => t.id === s.footage.id) - 1]!
    expect(above.name).toBe('Footage 2')
    expect(onTrack(above.id)).toEqual([[8, 4]])
  })

  it('cuts in one undo step, and pastes the cut clips back', () => {
    selectClips([s.a.id, s.b.id])
    expect(cutSelection()).toBe(true)
    expect(onTrack(s.footage.id)).toEqual([
      [8, 3],
      [14, 4],
    ])
    expect(editor.undoLabel()).toBe('Cut 2 clips')
    expect(get().selection).toEqual({ type: 'none' })
    set({ playhead: 30 })
    paste()
    expect(onTrack(s.footage.id).slice(-2)).toEqual([
      [30, 4],
      [34, 4],
    ])
  })

  it('deletes the selected clips, and a locked track rejects the whole delete', () => {
    selectClips([s.a.id, s.top.id])
    expect(deleteSelection()).toBe(true)
    expect(project().clips[s.a.id]).toBeDefined()
    expect(project().clips[s.top.id]).toBeDefined()

    selectClips([s.a.id, s.c.id])
    deleteSelection()
    expect(onTrack(s.footage.id)).toEqual([
      [4, 4],
      [14, 4],
    ])
    expect(editor.undoLabel()).toBe('Delete 2 clips')
    editor.undo()
    expect(onTrack(s.footage.id)).toHaveLength(4)
  })
})

describe('selection', () => {
  it('selects all clips on the selected clip’s track, or every clip but lyric lines', () => {
    selectClips([s.c.id])
    selectAll()
    expect(selectedClipIds(get().selection)).toEqual([s.a.id, s.b.id, s.c.id, s.d.id])
    set({ selection: { type: 'none' } })
    selectAll()
    expect(new Set(selectedClipIds(get().selection))).toEqual(
      new Set([s.a.id, s.top.id, s.b.id, s.c.id, s.d.id]),
    )
  })

  it('splits the clip it is given at the playhead, and only that clip', () => {
    set({ playhead: 9 })
    splitAtPlayhead(s.a.id)
    expect(onTrack(s.footage.id)).toHaveLength(4)
    splitAtPlayhead(s.c.id)
    expect(onTrack(s.footage.id)).toEqual([
      [0, 4],
      [4, 4],
      [8, 1],
      [9, 2],
      [14, 4],
    ])
  })
})

describe('lyric lines among several clips', () => {
  let line2: TextClip
  let lyricsTrack: string

  beforeEach(() => {
    const p = structuredClone(s.p)
    lyricsTrack = s.line.trackId
    p.lyrics = {
      source: 'pasted',
      lines: [
        { id: 'l1', text: 'Hello', start: 0, end: 4, words: [] },
        { id: 'l2', text: 'World', start: 5, end: 8, words: [] },
      ],
    }
    line2 = {
      ...createTextClip({ trackId: lyricsTrack, text: 'World', start: 5, duration: 3 }),
      lyricLineId: 'l2',
      style: { ...s.line.style, color: '#ff00aa' },
    }
    p.clips[line2.id] = line2
    editor.load(p)
    set({ selection: { type: 'none' }, playhead: 0, toasts: [] })
  })

  const lineIds = () => project().lyrics?.lines.map((l) => l.id)
  const lastToast = () => get().toasts.at(-1)?.message

  it('Delete takes the selected lines out of the lyrics with their clips, in the same undo step as the other clips', () => {
    // A director's emphasized word of the deleted line, selected too: removed once, with the line.
    const word = {
      ...createTextClip({ trackId: s.footage.id, text: 'Hello', start: 20, duration: 1 }),
      meta: { director: { planId: 'plan', role: 'text', textRole: 'emphasis', lyricLineId: 'l1' } },
    }
    editor.dispatch({ type: 'clip.add', clip: word }, { history: 'skip' })
    selectClips([s.a.id, s.line.id, word.id])
    expect(deleteSelection()).toBe(true)
    expect(project().clips[s.a.id]).toBeUndefined()
    expect(project().clips[s.line.id]).toBeUndefined()
    expect(project().clips[word.id]).toBeUndefined()
    expect(lineIds()).toEqual(['l2'])
    expect(project().clips[line2.id]).toEqual(line2)
    expect(editor.undoLabel()).toBe('Delete 2 clips and 1 lyric line')
    editor.undo()
    expect(lineIds()).toEqual(['l1', 'l2'])
    expect(project().clips[s.line.id]).toBeDefined()
    expect(project().clips[s.a.id]).toBeDefined()
  })

  it('a locked Lyrics track rejects the whole delete or cut', () => {
    editor.dispatch(
      { type: 'track.update', trackId: lyricsTrack, patch: { locked: true } },
      { history: 'skip' },
    )
    selectClips([s.a.id, s.line.id])
    deleteSelection()
    expect(cutSelection()).toBe(true)
    expect(project().clips[s.a.id]).toBeDefined()
    expect(project().clips[s.line.id]).toBeDefined()
    expect(lineIds()).toEqual(['l1', 'l2'])
    expect(lastToast()).toBe('That track is locked. Unlock it to edit.')
  })

  it('pastes copied lyric lines as text clips with their look, on a new Text track, never on the lyrics lane', () => {
    selectClips([s.line.id, line2.id])
    copySelection()
    expect(lastToast()).toBe('Copied 2 lyric lines')
    set({ playhead: 20 })
    paste()
    const text = project().tracks.find((t) => t.name === 'Text')!
    expect(text.kind).toBe('visual')
    const copies = selected()
    expect(copies.map((c) => [c?.trackId, c?.start])).toEqual([
      [text.id, 20],
      [text.id, 25],
    ])
    expect(copies.every((c) => c?.type === 'text' && c.lyricLineId === undefined)).toBe(true)
    expect(copies[1]).toMatchObject({ text: 'World', style: { color: '#ff00aa' } })
    expect(lineIds()).toEqual(['l1', 'l2'])
    expect(lastToast()).toBe('Pasted 2 lyric lines as text')

    // With other clips, those go back on their own track.
    selectClips([s.a.id, s.line.id])
    copySelection()
    expect(lastToast()).toBe('Copied 1 clip and 1 lyric line')
    set({ playhead: 40 })
    paste()
    expect(onTrack(s.footage.id)).toContainEqual([40, 4])
    expect(lastToast()).toBe('Pasted 1 clip and 1 lyric line as text')
    expect(Object.values(project().clips).filter((c) => c.trackId === lyricsTrack)).toHaveLength(2)
  })

  it('duplicates a lyric line as text, and a lone lyric chip selects its line', () => {
    selectClips([s.a.id, line2.id])
    duplicateSelection()
    expect(lastToast()).toBe('Duplicated 1 clip and 1 lyric line as text')
    expect(Object.values(project().clips).filter((c) => c.trackId === lyricsTrack)).toHaveLength(2)

    selectTimelineClips(project(), [line2.id])
    expect(get().selection).toEqual({ type: 'lyric', id: 'l2' })
    expect(timelineSelectionIds(project(), get().selection)).toEqual([line2.id])
    selectTimelineClips(project(), [s.a.id, line2.id])
    expect(selectedClipIds(get().selection)).toEqual([s.a.id, line2.id])
  })
})
