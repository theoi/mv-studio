import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, VideoClip } from '../../../src/model/index.ts'
import { cutoutCommands, cutoutsOf } from '../../../src/app/state/behind.ts'
import { assetPlacement } from '../../../src/app/state/importer.ts'
import { editor, loadDemoProject, viewOf } from '../../../src/app/state/project.ts'
import { replaceClipMedia } from '../../../src/app/state/replace.ts'
import { setShotsMuted, setShotsVolume, shotSilencedBy } from '../../../src/app/state/shotSound.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

beforeEach(() => loadDemoProject())

const project = () => editor.getProject()
const clip = (id: string) => project().clips[id] as VideoClip

function footage(id: string, hasAudio: boolean): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 1000,
    storageKey: `media/${id}`,
    duration: 4,
    width: 640,
    height: 360,
    hasAudio,
    origin: { type: 'import' },
    createdAt: '2026-11-01T00:00:00.000Z',
  }
}

/** Adds the footage to the project and the timeline at `start`, as Add at playhead and a drop do. */
function addShot(asset: Asset, start: number): string {
  editor.dispatch({ type: 'asset.add', asset })
  const placed = assetPlacement(project(), asset, { start })
  if (!placed) throw new Error('not placed')
  editor.dispatch(placed.commands)
  return placed.clip.id
}

describe('a shot’s own sound', () => {
  it('starts off for a shot added by hand, so only the song plays, and the timeline shows no speaker', () => {
    const id = addShot(footage('talk', true), 200)
    expect(clip(id).muted).toBe(true)
    expect(viewOf(project(), clip(id)).sound).toBeUndefined()
  })

  it('turns on and off for the shots with sound, one undo step each, leaving clips without sound alone', () => {
    const talk = addShot(footage('talk', true), 200)
    const silent = addShot(footage('silent', false), 205)
    expect(setShotsMuted([talk, silent], false)).toBe(true)
    expect(editor.undoLabel()).toBe('Unmute shot sound')
    expect([clip(talk).muted, clip(silent).muted]).toEqual([false, true])
    expect(viewOf(project(), clip(talk)).sound).toBe(true)
    expect(viewOf(project(), clip(silent)).sound).toBeUndefined()
    // Nothing left to change: no undo step.
    expect(setShotsMuted([talk], false)).toBe(false)
    expect(setShotsMuted([talk], true)).toBe(true)
    expect(editor.undoLabel()).toBe('Mute shot sound')
    editor.undo()
    expect(clip(talk).muted).toBe(false)
  })

  it('sets the volume, within 0 to 100%, and a level picked for a muted shot turns its sound on', () => {
    const talk = addShot(footage('talk', true), 200)
    expect(setShotsVolume([talk], 0.25)).toBe(true)
    expect(editor.undoLabel()).toBe('Change shot volume')
    expect([clip(talk).volume.value, clip(talk).muted]).toEqual([0.25, false])
    editor.undo()
    expect([clip(talk).volume.value, clip(talk).muted]).toEqual([1, true])
    // The Inspector's slider for several shots leaves muted ones muted.
    setShotsVolume([talk], 1.5, { keepMuted: true })
    expect([clip(talk).volume.value, clip(talk).muted]).toEqual([1, true])
    setShotsVolume([talk], -1)
    expect([clip(talk).volume.value, clip(talk).muted]).toEqual([0, false])
    // At 0% nothing plays, so the timeline shows no speaker.
    expect(viewOf(project(), clip(talk)).sound).toBeUndefined()
  })

  it('says why a shot set to play is silent: a hidden or muted track, or a solo', () => {
    const talk = addShot(footage('talk', true), 200)
    setShotsMuted([talk], false)
    expect(shotSilencedBy(project(), clip(talk))).toBeNull()
    const track = clip(talk).trackId
    editor.dispatch({ type: 'track.update', trackId: track, patch: { hidden: true } })
    expect(shotSilencedBy(project(), clip(talk))).toBe('Its track is hidden, so it’s silent.')
    editor.dispatch({ type: 'track.update', trackId: track, patch: { hidden: false, muted: true } })
    expect(shotSilencedBy(project(), clip(talk))).toBe('Its track is muted, so it’s silent.')
    editor.dispatch({ type: 'track.update', trackId: track, patch: { muted: false } })
    const song = project().tracks.find((t) => t.kind === 'audio')!
    editor.dispatch({ type: 'track.update', trackId: song.id, patch: { solo: true } })
    expect(shotSilencedBy(project(), clip(talk))).toBe('A soloed track or stem silences it.')
  })

  it('stays as it was when Replace shows other footage, and a still replaced by footage starts muted', () => {
    editor.dispatch({ type: 'asset.add', asset: footage('interview', true) })
    const talk = addShot(footage('talk', true), 200)
    setShotsVolume([talk], 0.4)
    expect(replaceClipMedia(talk, 'interview')).toBe(true)
    expect(clip(talk)).toMatchObject({ assetId: 'interview', muted: false, volume: { value: 0.4 } })

    const still = Object.values(project().clips).find((c: Clip) => c.type === 'image')!
    expect(replaceClipMedia(still.id, 'talk')).toBe(true)
    expect(clip(still.id)).toMatchObject({
      type: 'video',
      assetId: 'talk',
      muted: true,
      volume: { value: 1 },
    })
  })

  it('is left to the shot by its cutout for text behind the subject, which shows the same footage', () => {
    const singer = Object.values(project().clips).find((c) => c.type === 'video' && c.assetId === 'm-singer')!
    editor.dispatch({ type: 'clip.set', clipId: singer.id, path: ['muted'], value: false })
    editor.dispatch(cutoutCommands(project(), [singer.id]).commands)
    const [cutout] = cutoutsOf(project(), singer.id)
    expect(cutout).toMatchObject({ type: 'video', assetId: 'm-singer', muted: true })
    expect(clip(singer.id).muted).toBe(false)
  })
})
