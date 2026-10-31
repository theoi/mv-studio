import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, createVideoClip, type Asset, type Project } from '../../../src/model/index.ts'
import {
  addMarkerAtPlayhead,
  moveMarker,
  nextMarkerName,
  removeMarker,
  renameMarker,
} from '../../../src/app/state/markers.ts'
import { editor } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

/** A 20 s video clip, so the timeline is 20 s long. */
function scene(): Project {
  const p = createProject({ name: 'markers' })
  const asset: Asset = {
    id: 'v',
    kind: 'video',
    name: 'v',
    mimeType: 'video/mp4',
    byteSize: 1,
    storageKey: 'v',
    origin: { type: 'import' },
    createdAt: new Date(0).toISOString(),
  }
  p.assets = { v: asset }
  const clip = createVideoClip({ trackId: p.tracks[0]!.id, assetId: 'v', start: 0, duration: 20 })
  p.clips[clip.id] = clip
  return p
}

const markers = () => editor.getProject().markers.map((m) => [m.label, m.time])

beforeEach(() => {
  editor.load(scene())
  set({ playhead: 0, toasts: [] })
})

describe('markers', () => {
  it('adds a numbered marker at the playhead in one undo step, and not twice in the same place', () => {
    set({ playhead: 7 })
    const id = addMarkerAtPlayhead()
    set({ playhead: 3 })
    addMarkerAtPlayhead()
    expect(markers()).toEqual([
      ['Marker 2', 3],
      ['Marker 1', 7],
    ])
    expect(editor.undoLabel()).toBe('Add marker')
    expect(get().toasts.at(-1)?.message).toBe('Added Marker 2 at 0:03.0')

    set({ playhead: 7.02 })
    expect(addMarkerAtPlayhead()).toBe(id)
    expect(markers()).toHaveLength(2)
    expect(get().toasts.at(-1)?.message).toBe('Marker 1 is already at 0:07.0')

    editor.undo()
    expect(markers()).toEqual([['Marker 1', 7]])
  })

  it('names a new marker with the lowest free number', () => {
    const at = (label: string) => ({ id: label, time: 0, kind: 'user' as const, label })
    expect(nextMarkerName([])).toBe('Marker 1')
    expect(nextMarkerName([at('Marker 1'), at('Marker 3')])).toBe('Marker 2')
    expect(nextMarkerName([at('Drop'), at('Marker 1')])).toBe('Marker 2')
  })

  it('moves within the timeline, a drag being one undo step; renames and removes', () => {
    set({ playhead: 5 })
    const id = addMarkerAtPlayhead()!
    moveMarker(id, 6, true)
    moveMarker(id, 8, true)
    editor.endGesture()
    expect(markers()).toEqual([['Marker 1', 8]])
    editor.undo()
    expect(markers()).toEqual([['Marker 1', 5]])

    moveMarker(id, -3)
    expect(markers()).toEqual([['Marker 1', 0]])
    moveMarker(id, 99)
    expect(markers()).toEqual([['Marker 1', 20]])

    renameMarker(id, '  Drop  ')
    renameMarker(id, '   ')
    expect(markers()).toEqual([['Drop', 20]])
    expect(editor.undoLabel()).toBe('Rename marker')

    removeMarker(id)
    expect(markers()).toEqual([])
    editor.undo()
    expect(markers()).toEqual([['Drop', 20]])
  })
})
