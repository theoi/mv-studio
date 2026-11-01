import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, VideoClip } from '../../../src/model/index.ts'
import { cutoutCommands, cutoutsOf } from '../../../src/app/state/behind.ts'
import { addAssetAtPlayhead, assetPlacement } from '../../../src/app/state/importer.ts'
import { editor, loadDemoProject, viewOf } from '../../../src/app/state/project.ts'
import { replaceClipMedia } from '../../../src/app/state/replace.ts'
import { get, set, withdrawUndo } from '../../../src/app/state/ui.ts'
import {
  addedToast,
  setShotsMuted,
  setShotsVolume,
  shotSilencedBy,
  shotVolumeAt,
  volumeKeptNote,
} from '../../../src/app/state/shotSound.ts'

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

  it('sets a level on a shot with Volume keyframes as the keyframe at the playhead, and leaves one away from it', () => {
    const keyed = addShot(footage('talk', true), 200)
    const away = addShot(footage('away', true), 210)
    const plain = addShot(footage('plain', true), 215)
    for (const id of [keyed, away])
      editor.dispatch([
        {
          type: 'keyframe.set',
          clipId: id,
          path: ['volume'],
          keyframe: { time: 0, value: 1, easing: 'linear' },
        },
        {
          type: 'keyframe.set',
          clipId: id,
          path: ['volume'],
          keyframe: { time: 2, value: 0.2, easing: 'hold' },
        },
      ])
    const before = clip(away)

    expect(setShotsVolume([keyed, away, plain], 0.5, { at: 201 })).toBe(true)
    expect(editor.undoLabel()).toBe('Change shot volume')
    expect(shotVolumeAt(clip(keyed), 201)).toBe(0.5)
    expect(clip(keyed)).toMatchObject({
      muted: false,
      volume: {
        value: 1,
        keyframes: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 1, value: 0.5, easing: 'ease-in-out' },
          { time: 2, value: 0.2, easing: 'hold' },
        ],
      },
    })
    expect(clip(away)).toBe(before)
    expect(clip(plain)).toMatchObject({ muted: false, volume: { value: 0.5 } })
    expect(volumeKeptNote([clip(keyed), clip(away), clip(plain)], 201)).toBe(
      '1 shot has Volume keyframes away from the playhead, so its volume stays. Move the playhead over it to set a keyframe there.',
    )
    expect(volumeKeptNote([clip(keyed), clip(away)], 216)).toMatch(/^2 shots have Volume keyframes/)
    expect(volumeKeptNote([clip(away)], 211)).toBeNull()

    // On a keyframe, the level replaces it, keeping its time and easing.
    setShotsVolume([keyed], 0.3, { at: 202 })
    expect(clip(keyed).volume.keyframes?.at(-1)).toEqual({ time: 2, value: 0.3, easing: 'hold' })
    // Only shots away from the playhead: nothing changes.
    expect(setShotsVolume([away], 0.3, { at: 201 })).toBe(false)
  })

  it('says in the add toast that the shot’s sound is off and offers to turn it on, not for a silent file or a still', () => {
    editor.dispatch({ type: 'asset.add', asset: footage('talk', true) })
    editor.dispatch({ type: 'asset.add', asset: footage('silent', false) })
    set({ playhead: 200 })
    const lastToast = () => get().toasts.at(-1)!
    const selected = () => {
      const { selection } = get()
      return selection.type === 'clip' ? selection.id : ''
    }

    addAssetAtPlayhead('talk')
    const talk = selected()
    expect(lastToast().message).toMatch(/^Added “.+” at \S+\. Its sound is off\.$/)
    expect(lastToast().action?.label).toBe('Undo')
    expect(lastToast().fix?.label).toBe('Turn sound on')
    // Another edit takes back Undo, and the toast stays with its fix.
    withdrawUndo()
    expect(lastToast()).toMatchObject({ action: undefined, fix: { label: 'Turn sound on' } })
    lastToast().fix!.run()
    expect(clip(talk).muted).toBe(false)
    expect(editor.undoLabel()).toBe('Unmute shot sound')
    editor.undo()
    expect(clip(talk).muted).toBe(true)

    // Turned on another way, the toast closes on the next edit.
    addAssetAtPlayhead('talk')
    const again = lastToast()
    setShotsMuted([selected()], false)
    withdrawUndo()
    expect(get().toasts).not.toContain(again)

    addAssetAtPlayhead('silent')
    expect(lastToast().message).not.toMatch(/sound/)
    expect(lastToast().fix).toBeUndefined()
    const still = Object.values(project().assets).find((a) => a.kind === 'image')!
    addAssetAtPlayhead(still.id)
    expect(lastToast().message).not.toMatch(/sound/)
    expect(lastToast().fix).toBeUndefined()

    expect(addedToast('Added 2 files', [talk, selected()]).message).toBe(
      'Added 2 files. Sound is off for 1 of them.',
    )
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
