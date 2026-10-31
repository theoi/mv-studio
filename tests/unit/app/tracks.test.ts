import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProject,
  createSolidClip,
  createTextClip,
  createTrack,
  type Project,
  type Track,
} from '../../../src/model/index.ts'
import { dispatch, editor } from '../../../src/app/state/project.ts'
import {
  coveringNote,
  moveAnnouncement,
  moveTrack,
  moveTrackBy,
  trackMoveRange,
} from '../../../src/app/state/tracks.ts'
import { get } from '../../../src/app/state/ui.ts'

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
    expect(editor.undoLabel()).toBe('Move C up')
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

  it('tells a screen reader where the track is now among its kind, or that it is at the end', () => {
    const [a, b, , x] = editor.getProject().tracks
    moveTrackBy(b!.id, 1)
    expect(moveAnnouncement(editor.getProject(), b!.id, 1, true)).toBe('Moved the B track down, to 3 of 3.')
    expect(moveAnnouncement(editor.getProject(), a!.id, -1, false)).toBe("The A track can't move further up.")
    moveTrackBy(x!.id, 1)
    expect(moveAnnouncement(editor.getProject(), x!.id, 1, true)).toBe('Moved the X track down, to 2 of 2.')
  })
})

/** Lyrics over a look over Overlay (a visualizer-like solid) over Video, plus an empty track and a text track. */
function layered() {
  const p: Project = createProject({ name: 'layers' })
  const [lyrics, look, overlay, video, empty, words] = [
    'Lyrics',
    'Look',
    'Overlay',
    'Video',
    'Empty',
    'Words',
  ].map((n) => createTrack('visual', n)) as Track[]
  p.tracks = [lyrics!, look!, overlay!, video!, empty!, words!]
  const line = {
    ...createTextClip({ trackId: lyrics!.id, text: 'Hello', start: 0, duration: 4 }),
    lyricLineId: 'l1',
  }
  const { color: _color, ...rest } = createSolidClip({
    trackId: look!.id,
    color: '#000000',
    start: 0,
    duration: 9,
  })
  const tint = { ...rest, type: 'adjustment' as const, meta: { role: 'look' } }
  const spectrum = createSolidClip({ trackId: overlay!.id, color: '#ffffff', start: 2, duration: 3 })
  const shot = createSolidClip({ trackId: video!.id, color: '#ff0000', start: 0, duration: 9 })
  const title = createTextClip({ trackId: words!.id, text: 'Title', start: 0, duration: 2 })
  for (const c of [line, tint, spectrum, shot, title]) p.clips[c.id] = c
  return p
}

describe('the note when a move changes what covers what', () => {
  const ids = (p: Project) => Object.fromEntries(p.tracks.map((t) => [t.name, t.id]))
  const moved = (p: Project, name: string, to: number): Project => {
    const tracks = p.tracks.filter((t) => t.name !== name)
    tracks.splice(
      to,
      0,
      p.tracks.find((t) => t.name === name)!,
    )
    return { ...p, tracks }
  }

  it('says the lyrics are behind the track that now covers them, whichever of the two moved', () => {
    const p = layered()
    expect(coveringNote(p, moved(p, 'Lyrics', 2), ids(p).Lyrics!)).toBe(
      'The lyrics are behind the Overlay track now, which covers them.',
    )
    expect(coveringNote(p, moved(p, 'Lyrics', 3), ids(p).Lyrics!)).toBe(
      'The lyrics are behind the video now, which covers them.',
    )
    expect(coveringNote(p, moved(p, 'Video', 0), ids(p).Video!)).toBe(
      'The lyrics are behind the video now, which covers them.',
    )
  })

  it('says text is behind a track for a text track, and that the look no longer colors one moved above it', () => {
    const p = layered()
    const wordsOnTop = moved(p, 'Words', 0)
    expect(coveringNote(wordsOnTop, moved(wordsOnTop, 'Words', 5), ids(p).Words!)).toBe(
      'This text is behind the video now, which covers it.',
    )
    const credit = createTextClip({ trackId: ids(p).Words!, text: 'Credit', start: 5, duration: 2 })
    const twoTexts = { ...wordsOnTop, clips: { ...wordsOnTop.clips, [credit.id]: credit } }
    expect(coveringNote(twoTexts, moved(twoTexts, 'Words', 3), ids(p).Words!)).toBe(
      'These text clips are behind the Overlay track now, which covers them.',
    )
    expect(coveringNote(p, moved(p, 'Look', 2), ids(p).Look!)).toBe(
      'The look no longer colors the tracks above it.',
    )
    const lookLow = moved(p, 'Look', 3)
    expect(coveringNote(lookLow, moved(lookLow, 'Look', 1), ids(p).Look!)).toBeNull()
  })

  it('says nothing for an empty track or a move that does not cross a covering track', () => {
    const p = layered()
    expect(coveringNote(p, moved(p, 'Lyrics', 1), ids(p).Lyrics!)).toBeNull()
    expect(coveringNote(p, moved(p, 'Overlay', 3), ids(p).Overlay!)).toBeNull()
    expect(coveringNote(p, moved(p, 'Empty', 0), ids(p).Empty!)).toBeNull()
  })

  it('shows the note with Undo after a move from the timeline', () => {
    editor.load(layered())
    const lyrics = editor.getProject().tracks[0]!
    moveTrack(lyrics.id, 2)
    expect(get().toasts.at(-1)).toMatchObject({
      message: 'The lyrics are behind the Overlay track now, which covers them.',
      action: { label: 'Undo' },
    })
    get().toasts.at(-1)?.action?.run()
    expect(names()).toEqual(['Lyrics', 'Look', 'Overlay', 'Video', 'Empty', 'Words'])
  })

  it("leaves a later edit alone: the note's Undo only undoes the move while it is still the last edit", () => {
    editor.load(layered())
    const [lyrics, , , , empty, words] = editor.getProject().tracks
    moveTrack(lyrics!.id, 2)
    const undoMove = get().toasts.at(-1)!.action!.run
    const moved = ['Look', 'Overlay', 'Lyrics', 'Video', 'Empty', 'Words']

    dispatch({ type: 'track.update', trackId: words!.id, patch: { hidden: true } }, { label: 'Hide track' })
    undoMove()
    expect(names()).toEqual(moved)
    expect(editor.getProject().tracks.find((t) => t.id === words!.id)?.hidden).toBe(true)

    // Another move has the same label.
    editor.undo()
    moveTrack(empty!.id, 0)
    undoMove()
    expect(names()).toEqual(['Empty', ...moved.filter((n) => n !== 'Empty')])

    // Once the later move is undone, the note's move is the last edit again.
    editor.undo()
    undoMove()
    expect(names()).toEqual(['Lyrics', 'Look', 'Overlay', 'Video', 'Empty', 'Words'])
  })
})
