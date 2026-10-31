import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, createTrack, type Project } from '../../../src/model/index.ts'
import { editor } from '../../../src/app/state/project.ts'
import { moveTrack, moveTrackBy, trackMoveRange } from '../../../src/app/state/tracks.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

/** Three visual tracks over two audio tracks. */
function scene() {
  const p: Project = createProject({ name: 'tracks' })
  const [a, b, c] = ['A', 'B', 'C'].map((n) => createTrack('visual', n))
  const [x, y] = ['X', 'Y'].map((n) => createTrack('audio', n))
  p.tracks = [a!, b!, c!, x!, y!]
  return p
}

const names = () => editor.getProject().tracks.map((t) => t.name)

beforeEach(() => editor.load(scene()))

describe('track order', () => {
  it('moves a track among the tracks of its kind, as one undo step', () => {
    const c = editor.getProject().tracks[2]!
    expect(moveTrack(c.id, 0)).toBe(true)
    expect(names()).toEqual(['C', 'A', 'B', 'X', 'Y'])
    expect(editor.undoLabel()).toBe('Move track')
    editor.undo()
    expect(names()).toEqual(['A', 'B', 'C', 'X', 'Y'])
  })

  it('keeps visual tracks above audio tracks', () => {
    const [a, , , x] = editor.getProject().tracks
    expect(trackMoveRange(editor.getProject(), a!.id)).toEqual({ min: 0, max: 2 })
    expect(trackMoveRange(editor.getProject(), x!.id)).toEqual({ min: 3, max: 4 })
    moveTrack(a!.id, 4)
    expect(names()).toEqual(['B', 'C', 'A', 'X', 'Y'])
    moveTrack(x!.id, 0)
    expect(names()).toEqual(['B', 'C', 'A', 'X', 'Y'])
  })

  it('moves one place up or down, and not past the ends of its kind', () => {
    const [a, b] = editor.getProject().tracks
    expect(moveTrackBy(a!.id, -1)).toBe(false)
    expect(moveTrackBy(b!.id, -1)).toBe(true)
    expect(names()).toEqual(['B', 'A', 'C', 'X', 'Y'])
    expect(moveTrackBy(a!.id, 1)).toBe(true)
    expect(moveTrackBy(a!.id, 1)).toBe(false)
    expect(names()).toEqual(['B', 'C', 'A', 'X', 'Y'])
  })
})
