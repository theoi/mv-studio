import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../../../src/model/index.ts'
import { dropMedia, endMediaDrag, mediaDropHint, startMediaDrag } from '../../../src/app/state/mediaDrag.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { get } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

// The sample's Video track has 4 s shots in the first verse (16 to 48 s) and 2 s shots in the first chorus (64 to
// 96 s); Overlay has a title until 9 s and Spectrum bars from 64 s.
beforeEach(() => loadDemoProject())

const project = () => editor.getProject()
const lastToast = () => get().toasts.at(-1)
const drag = { dataTransfer: null }

/** Drags a Library › Media card over a track at `time` and drops it there, returning the hint shown before the drop. */
function dropCard(assetId: string, trackId: string, time: number) {
  const at = { trackId, time, pointer: time, alt: false }
  startMediaDrag(drag, assetId)
  const hint = mediaDropHint(at)
  dropMedia(drag, at)
  endMediaDrag()
  const selection = get().selection
  const clip = selection.type === 'clip' ? project().clips[selection.id] : undefined
  return { hint, clip }
}

const removeShots = (...ids: string[]) => editor.dispatch({ type: 'clip.remove', clipIds: ids })

/** A video file in the library, `duration` seconds long. */
const video = (id: string, duration: number): Asset => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  mimeType: 'video/mp4',
  byteSize: 1,
  storageKey: id,
  duration,
  origin: { type: 'import' },
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('a Library › Media card dropped on the timeline', () => {
  it('fills the gap a deleted shot left on that track, trimmed when it is longer, as one undo step', () => {
    removeShots('c-s-c1-1')
    const { hint, clip } = dropCard('m-dancer', 't-video', 66.5)
    expect(hint).toEqual({ trackId: 't-video', start: 66, end: 68, trimmed: true })
    expect(clip).toMatchObject({
      trackId: 't-video',
      assetId: 'm-dancer',
      start: 66,
      duration: 2,
      sourceStart: 0,
    })
    expect(editor.undoLabel()).toBe('Add Dancer')
    expect(lastToast()?.message).toBe('Added “Dancer” at 1:06.0, trimmed to fill the 2.0 s gap')
    lastToast()?.action?.run()
    expect(project().clips[clip!.id]).toBeUndefined()
  })

  it('lands in a gap longer than itself as near the drop point as the gap allows', () => {
    removeShots('c-s-c1-1', 'c-s-c1-2', 'c-s-c1-3')
    // A photo is 2 bars, 4 s at 120 BPM; let go at 1:09.5 it would run past the shot at 1:12.
    const { hint, clip } = dropCard('m-sunset', 't-video', 69.5)
    expect(hint).toEqual({ trackId: 't-video', start: 68, end: 72 })
    expect(clip).toMatchObject({ trackId: 't-video', start: 68, duration: 4 })
    expect(lastToast()?.message).toBe('Added “Rooftop sunset” at 1:08.0')
  })

  it('goes on another track when dropped on a shot, and both the drag and the toast say where', () => {
    const { hint, clip } = dropCard('m-dancer', 't-video', 20.5)
    expect(hint).toMatchObject({
      trackId: 't-overlay',
      start: 20.5,
      end: 30,
      elsewhere: { trackId: 't-video', at: 20.5, name: 'Overlay' },
      canReplace: { trackId: 't-video', at: 20 },
    })
    expect(clip).toMatchObject({ trackId: 't-overlay', start: 20.5, duration: 9.5 })
    expect(lastToast()?.message).toBe('Added “Dancer” on Overlay at 0:20.5: Video is full there')

    // In the chorus Overlay has Spectrum bars, so a new track takes it.
    const second = dropCard('m-dancer', 't-video', 66.5)
    expect(second.hint).toMatchObject({
      trackId: 't-video',
      newTrack: true,
      elsewhere: { trackId: 't-video', at: 66.5, name: 'a new track' },
    })
    expect(project().tracks.find((t) => t.id === second.clip?.trackId)?.name).toBe('Video 2')
    expect(lastToast()?.message).toBe('Added “Dancer” on a new track, Video 2, at 1:06.5')
  })

  it('in a long gap, keeps a longer card at the drop point and trims it at the next clip, unless dropped within a bar of the gap’s start', () => {
    // Overlay is empty from the title's end at 9 s to Spectrum bars at 64 s; a bar is 2 s at 120 BPM.
    editor.dispatch({ type: 'asset.add', asset: video('long', 120) })
    const far = dropCard('long', 't-overlay', 30)
    expect(far.hint).toEqual({ trackId: 't-overlay', start: 30, end: 64, trimmed: true })
    expect(far.clip).toMatchObject({ trackId: 't-overlay', start: 30, duration: 34 })
    expect(lastToast()?.message).toBe(
      'Added “long” at 0:30.0, trimmed to 34.0 s to end at the next clip. Its sound is off.',
    )
    editor.undo()

    const near = dropCard('long', 't-overlay', 10.5)
    expect(near.clip).toMatchObject({ trackId: 't-overlay', start: 9, duration: 55 })
    expect(lastToast()?.message).toBe(
      'Added “long” at 0:09.0, trimmed to fill the 55.0 s gap. Its sound is off.',
    )
  })

  it('stays on the hovered track when its fitted end rounds a hair past the gap’s end', () => {
    // A gap from 84 s to 89.473 s, where 84.656 + 4.817 comes out a hair above 89.473.
    const shotAt = (t: number) =>
      Object.values(project().clips).find((c) => c.trackId === 't-video' && c.start === t)!
    removeShots(shotAt(84).id, shotAt(86).id)
    editor.dispatch({ type: 'clip.trim', clipId: shotAt(88).id, start: 89.473, duration: 0.527 })
    editor.dispatch({ type: 'asset.add', asset: video('odd', 4.817) })
    const nudged = dropCard('odd', 't-video', 89)
    expect(nudged.hint).toMatchObject({ trackId: 't-video', start: 84.656 })
    expect(nudged.hint).not.toHaveProperty('newTrack')
    expect(nudged.clip).toMatchObject({ trackId: 't-video', start: 84.656 })
    expect(nudged.clip!.start + nudged.clip!.duration).toBeCloseTo(89.473, 9)

    // Trimmed to a gap from 9.043 s to 73.045 s on Overlay.
    editor.dispatch({ type: 'clip.trim', clipId: 'o-title', start: 0, duration: 9.043 })
    const spectrum = project().clips['o-spec1']!
    editor.dispatch({
      type: 'clip.trim',
      clipId: spectrum.id,
      start: 73.045,
      duration: spectrum.start + spectrum.duration - 73.045,
    })
    editor.dispatch({ type: 'asset.add', asset: video('long', 120) })
    const trimmed = dropCard('long', 't-overlay', 9.5)
    expect(trimmed.hint).toMatchObject({ trackId: 't-overlay', start: 9.043, trimmed: true })
    expect(trimmed.clip).toMatchObject({ trackId: 't-overlay', start: 9.043 })
    expect(trimmed.clip!.start + trimmed.clip!.duration).toBeCloseTo(73.045, 9)
  })

  it('lands at the drop point at its full length after the last shot', () => {
    const { hint, clip } = dropCard('m-dancer', 't-video', 210)
    expect(hint).toEqual({ trackId: 't-video', start: 210, end: 219.5 })
    expect(clip).toMatchObject({ trackId: 't-video', start: 210, duration: 9.5 })
    expect(lastToast()?.message).toBe('Added “Dancer” at 3:30.0')
  })
})
