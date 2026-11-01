import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipsOnTrack, type Asset } from '../../../src/model/index.ts'
import {
  dropMedia,
  endMediaDrag,
  insertTarget,
  mediaDropHint,
  startMediaDrag,
} from '../../../src/app/state/mediaDrag.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { barsState } from '../../../src/app/state/songAnalysis.ts'
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

/**
 * Drags a Library › Media card over a track at `time` and drops it there, with Ctrl held when `mod`, returning the hint
 * shown before the drop.
 */
function dropCard(assetId: string, trackId: string, time: number, mod = false) {
  const at = { trackId, time, pointer: time, alt: false, mod }
  startMediaDrag(drag, assetId)
  const hint = mediaDropHint(at)
  dropMedia(drag, at)
  endMediaDrag()
  const selection = get().selection
  const clip = selection.type === 'clip' ? project().clips[selection.id] : undefined
  return { hint, clip }
}

const removeShots = (...ids: string[]) => editor.dispatch({ type: 'clip.remove', clipIds: ids })

/** Tags every shot on the Video track as made by `meta`, as an auto-cut or a director draft tags its shots. */
function tagShots(meta: Record<string, unknown>) {
  for (const c of clipsOnTrack(project(), 't-video'))
    editor.dispatch({ type: 'clip.set', clipId: c.id, path: ['meta'], value: meta })
}

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

  it('goes in at the nearer cut when dropped on a shot, the later shots moving right by its length, as one undo step', () => {
    const before = project()
    const later = clipsOnTrack(before, 't-video').filter((c) => c.start >= 20)
    const { hint, clip } = dropCard('m-dancer', 't-video', 20.5)
    expect(hint).toEqual({
      trackId: 't-video',
      start: 20,
      end: 29.5,
      insert: { at: 20, moved: later.length, pastSong: 9.5 },
      canReplace: { trackId: 't-video', at: 20 },
    })
    expect(clip).toMatchObject({ trackId: 't-video', assetId: 'm-dancer', start: 20, duration: 9.5 })
    for (const c of later) expect(project().clips[c.id]?.start).toBeCloseTo(c.start + 9.5, 9)
    // The shot before the cut and the other tracks stay.
    const shotBefore = clipsOnTrack(before, 't-video').find((c) => c.start === 16)!
    expect(project().clips[shotBefore.id]).toEqual(shotBefore)
    expect(project().clips['o-spec1']).toEqual(before.clips['o-spec1'])
    expect(editor.undoLabel()).toBe('Insert Dancer')
    // The song is 3:24, as long as the picture was.
    expect(lastToast()?.message).toBe(
      `Inserted “Dancer” at 0:20.0. The ${later.length} clips after it moved 9.5 s later. The video now ends 9.5 s after the song.`,
    )
    lastToast()?.action?.run()
    expect(project()).toEqual(before)

    // Let go in the second half of a shot, it goes in after it.
    expect(dropCard('m-dancer', 't-video', 23.5).clip).toMatchObject({ trackId: 't-video', start: 24 })
  })

  it('with Ctrl held, goes in by insert at the drop point, even in a gap it would fill without', () => {
    removeShots('c-s-c1-1')
    const later = clipsOnTrack(project(), 't-video').filter((c) => c.start > 66.5)
    const { hint, clip } = dropCard('m-dancer', 't-video', 66.5, true)
    expect(hint).toEqual({
      trackId: 't-video',
      start: 66.5,
      end: 76,
      insert: { at: 66.5, moved: later.length, pastSong: 9.5 },
    })
    expect(clip).toMatchObject({ trackId: 't-video', start: 66.5, duration: 9.5 })
    for (const c of later) expect(project().clips[c.id]?.start).toBeCloseTo(c.start + 9.5, 9)
    expect(lastToast()?.message).toMatch(
      /^Inserted “Dancer” at 1:06\.5\. The \d+ clips after it moved 9\.5 s later\./,
    )

    // Not on the look lane or the Lyrics track, which take no footage: there it goes where it fits, moving nothing.
    for (const trackId of ['t-look', 't-lyrics']) {
      const was = clipsOnTrack(project(), trackId)
      expect(dropCard('m-dancer', trackId, 30, true).hint).not.toHaveProperty('insert')
      expect(
        clipsOnTrack(project(), trackId).filter((c) => !('assetId' in c && c.assetId === 'm-dancer')),
      ).toEqual(was)
    }
  })

  it('goes in muted when its file has sound, and the toast says so with Turn sound on', () => {
    editor.dispatch({ type: 'asset.add', asset: video('cam', 6) })
    const { clip } = dropCard('cam', 't-video', 20.5)
    expect(clip).toMatchObject({ trackId: 't-video', start: 20, duration: 6, muted: true })
    const toast = lastToast()
    expect(toast?.message).toMatch(
      /^Inserted “cam” at 0:20\.0\. The \d+ clips after it moved 6\.0 s later\. The video now ends 6\.0 s after the song\. Its sound is off\.$/,
    )
    expect(toast?.fix?.label).toBe('Turn sound on')
    toast?.fix?.run()
    expect(project().clips[clip!.id]).toMatchObject({ muted: false })
    // A silent file, as the sample's are, says nothing about sound.
    expect(dropCard('m-dancer', 't-video', 20.5).clip).toMatchObject({ muted: true })
    expect(lastToast()?.message).not.toMatch(/sound/)
    expect(lastToast()?.fix).toBeUndefined()
  })

  it('after the last shot, goes in at its end, and the drag already says the video then runs past the song', () => {
    const { hint, clip } = dropCard('m-dancer', 't-video', 203.5)
    expect(hint).toEqual({
      trackId: 't-video',
      start: 204,
      end: 213.5,
      insert: { at: 204, moved: 0, pastSong: 9.5 },
      canReplace: { trackId: 't-video', at: 204 },
    })
    expect(clip).toMatchObject({ trackId: 't-video', start: 204, duration: 9.5 })
    expect(lastToast()?.message).toBe('Inserted “Dancer” at 3:24.0. The video now ends 9.5 s after the song.')
  })

  it('plans an insert again after an edit, though the pointer is still at the same cut', () => {
    const at = { trackId: 't-video', time: 20.5, pointer: 20.5, alt: false }
    startMediaDrag(drag, 'm-dancer')
    const later = clipsOnTrack(project(), 't-video').filter((c) => c.start >= 20).length
    expect(mediaDropHint(at)).toMatchObject({ insert: { at: 20, moved: later } })
    removeShots('c-s-c1-1')
    expect(mediaDropHint(at)).toMatchObject({ insert: { at: 20, moved: later - 1 } })
    endMediaDrag()
  })

  it('takes no insert on a hidden track, where the shots it pushed would be out of sight, and says so', () => {
    editor.dispatch({ type: 'track.update', trackId: 't-video', patch: { hidden: true } })
    const before = project()
    for (const mod of [false, true]) {
      const { hint } = dropCard('m-dancer', 't-video', 20.5, mod)
      expect(hint).toEqual({ trackId: 't-video', hidden: true, at: 20 })
      expect(project()).toBe(before)
      expect(lastToast()?.message).toBe('Track is hidden: show it to insert')
    }
  })

  it.each([
    ['an auto-cut', { autocut: { v: 1, run: 'r1', fp: '00000000' } }],
    ['a director draft', { director: { planId: 'p1', role: 'shots' } }],
  ])(
    'on shots %s cut to the music, is trimmed to whole bars, so the later cuts move by whole bars and stay on the bar lines',
    (_, meta) => {
      tagShots(meta)
      const bars = barsState(project())
      const downbeats = bars.status === 'ready' ? bars.downbeats : []
      const onBar = (t: number) => downbeats.some((d) => Math.abs(d - t) < 1e-6)
      const later = clipsOnTrack(project(), 't-video').filter((c) => c.start >= 20)
      // Bars are 2 s at 120 BPM, so the 9.5 s video goes in as 4 bars.
      const { hint, clip } = dropCard('m-dancer', 't-video', 20.5)
      expect(hint).toMatchObject({ start: 20, end: 28, insert: { at: 20, moved: later.length, bars: 4 } })
      expect(clip).toMatchObject({ trackId: 't-video', start: 20, duration: 8, sourceStart: 0 })
      const songEnd = downbeats.at(-1) ?? 0
      const stayOnBars = later.filter((c) => onBar(c.start) && c.start + 8 <= songEnd)
      expect(stayOnBars.length).toBeGreaterThan(10)
      for (const c of stayOnBars) expect(onBar(project().clips[c.id]!.start), c.id).toBe(true)
      for (const c of later) expect(project().clips[c.id]?.start).toBeCloseTo(c.start + 8, 9)
      expect(lastToast()?.message).toBe(
        `Inserted “Dancer” at 0:20.0, trimmed to 4 bars to stay on the beat. The ${later.length} clips after it moved 8.0 s later. The video now ends 8.0 s after the song.`,
      )
      editor.undo()

      // After the last shot nothing moves, so it keeps its length.
      expect(dropCard('m-dancer', 't-video', 203.5).clip).toMatchObject({ start: 204, duration: 9.5 })
    },
  )

  it('keeps its length on shots cut to the music while the song’s bars aren’t found', () => {
    tagShots({ autocut: { v: 1, run: 'r1', fp: '00000000' } })
    const songId = project().songAssetId!
    const { tempo, beats } = project().analysis.audio[songId]!
    editor.dispatch({ type: 'analysis.setGrid', assetId: songId, grid: { tempo, beats, downbeats: [] } })
    const { hint, clip } = dropCard('m-dancer', 't-video', 20.5)
    expect(hint).toMatchObject({ start: 20, end: 29.5 })
    expect(hint).not.toHaveProperty('insert.bars')
    expect(clip).toMatchObject({ start: 20, duration: 9.5 })
  })

  it('goes on another track when dropped on a clip that isn’t a shot, and both the drag and the toast say where', () => {
    // In the chorus Overlay has Spectrum bars and Video its shots, so a new track takes it.
    const { hint, clip } = dropCard('m-dancer', 't-overlay', 66.5)
    expect(hint).toMatchObject({
      trackId: 't-overlay',
      newTrack: true,
      elsewhere: { trackId: 't-overlay', at: 66.5, name: 'a new track' },
    })
    expect(hint).not.toHaveProperty('insert')
    expect(project().tracks.find((t) => t.id === clip?.trackId)?.name).toBe('Video 2')
    expect(lastToast()?.message).toBe('Added “Dancer” on a new track, Video 2, at 1:06.5')
  })

  it('inserts from the palette on the footage track at the playhead, or on the track the clip menu names', () => {
    expect(insertTarget(project(), 30)).toEqual({
      trackId: 't-video',
      time: 30,
      pointer: 30,
      alt: false,
      mod: true,
    })
    // Past the last shot too: the footage track, not the Overlay above it.
    expect(insertTarget(project(), 210)?.trackId).toBe('t-video')
    expect(insertTarget(project(), 30, 't-overlay')?.trackId).toBe('t-overlay')

    // With Video hidden, the shown track that has footage too; with that hidden as well, Video, which refuses it.
    dropCard('m-dancer', 't-overlay', 30)
    editor.dispatch({ type: 'track.update', trackId: 't-video', patch: { hidden: true } })
    expect(insertTarget(project(), 30)?.trackId).toBe('t-overlay')
    editor.dispatch({ type: 'track.update', trackId: 't-overlay', patch: { hidden: true } })
    expect(insertTarget(project(), 30)?.trackId).toBe('t-video')
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
