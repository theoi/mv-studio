import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Clip, ImageClip, Project } from '../../../src/model/index.ts'
import { cutoutCommands, cutoutsOf } from '../../../src/app/state/behind.ts'
import { stillClips } from '../../../src/app/state/camera.ts'
import { dropMedia, endMediaDrag, mediaDropHint, startMediaDrag } from '../../../src/app/state/mediaDrag.ts'
import { editor, loadDemoProject, viewOf } from '../../../src/app/state/project.ts'
import { replaceClipMedia, replaceTarget } from '../../../src/app/state/replace.ts'
import { get, selectClips } from '../../../src/app/state/ui.ts'

beforeAll(() => {
  // Toasts time out through window.setTimeout.
  vi.stubGlobal('window', globalThis)
})

/** A chorus close-up of the singer, 2 s long, whose scale reacts to the beat. */
const CLOSE_UP = 'c-s-c1-1'

let start: Project
beforeEach(() => {
  loadDemoProject()
  // Its own effect and a keyframe, to see that they stay.
  editor.dispatch([
    {
      type: 'effect.add',
      clipId: CLOSE_UP,
      effect: { id: 'fx-1', effectId: 'glow', enabled: true, params: { amount: { value: 0.4 } } },
    },
    {
      type: 'keyframe.set',
      clipId: CLOSE_UP,
      path: ['opacity'],
      keyframe: { time: 0.5, value: 0.6, easing: 'linear' },
    },
  ])
  start = editor.getProject()
})

const project = () => editor.getProject()
const lastToast = () => get().toasts.at(-1)

describe('Replace with…', () => {
  it('shows other footage and keeps the clip’s place, length, effects, keyframes and reactions, as one undo step', () => {
    const before = start.clips[CLOSE_UP] as Extract<Clip, { type: 'video' }>
    expect(before.transform.scaleX.modulation).toBeDefined()
    editor.dispatch({ type: 'clip.trim', clipId: CLOSE_UP, start: before.start + 0.5, duration: 1.5 })
    const trimmed = project().clips[CLOSE_UP] as Extract<Clip, { type: 'video' }>
    expect(trimmed.sourceStart).toBeGreaterThan(0)

    expect(replaceClipMedia(CLOSE_UP, 'm-city')).toBe(true)
    const after = project().clips[CLOSE_UP]!
    expect(after).toEqual({ ...trimmed, assetId: 'm-city', sourceStart: 0 })
    expect(viewOf(project(), after).name).toBe('Night city')
    expect(editor.undoLabel()).toBe('Replace Singer close-up with Night city')
    expect(lastToast()?.message).toBe('Replaced “Singer close-up” with “Night city”')
    expect(get().selection).toEqual({ type: 'clip', id: CLOSE_UP })

    lastToast()?.action?.run()
    expect(project().clips[CLOSE_UP]).toEqual(trimmed)
    editor.redo()
    expect(project().clips[CLOSE_UP]).toEqual(after)
  })

  it('turns a video clip into a photo and back, keeping its look', () => {
    const before = start.clips[CLOSE_UP] as Extract<Clip, { type: 'video' }>
    replaceClipMedia(CLOSE_UP, 'm-sunset')
    const photo = project().clips[CLOSE_UP]!
    expect(photo.type).toBe('image')
    expect(photo).not.toHaveProperty('sourceStart')
    expect(photo).toMatchObject({
      start: before.start,
      duration: before.duration,
      effects: before.effects,
      transform: before.transform,
      opacity: before.opacity,
    })

    replaceClipMedia(CLOSE_UP, 'm-neon')
    expect(project().clips[CLOSE_UP]).toMatchObject({
      type: 'video',
      assetId: 'm-neon',
      sourceStart: 0,
      playbackRate: 1,
      effects: before.effects,
      transform: before.transform,
    })
  })

  it('renames a clip named after its old file, and keeps a name of its own', () => {
    editor.dispatch({ type: 'clip.set', clipId: CLOSE_UP, path: ['name'], value: 'Singer close-up' })
    replaceClipMedia(CLOSE_UP, 'm-city')
    expect(project().clips[CLOSE_UP]?.name).toBe('Night city')
    editor.dispatch({ type: 'clip.set', clipId: CLOSE_UP, path: ['name'], value: 'Hook shot' })
    replaceClipMedia(CLOSE_UP, 'm-neon')
    expect(project().clips[CLOSE_UP]?.name).toBe('Hook shot')
  })

  it('renames a clip named after its old file with the extension, as auto-cut names its clips, even with an effect', () => {
    const file = (id: string, name: string): Asset => ({
      id,
      kind: 'video',
      name,
      mimeType: 'video/webm',
      byteSize: 1,
      storageKey: id,
      duration: 10,
      origin: { type: 'import' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    editor.dispatch([
      { type: 'asset.add', asset: file('waves', 'clip01_16x9_waves.webm') },
      { type: 'asset.add', asset: file('bee', 'clip04_16x9_bee-lavender.webm') },
    ])
    replaceClipMedia(CLOSE_UP, 'waves')
    editor.dispatch({ type: 'clip.set', clipId: CLOSE_UP, path: ['name'], value: 'clip01_16x9_waves.webm' })
    const glow = (start.clips[CLOSE_UP] as Extract<Clip, { type: 'video' }>).effects
    expect(glow).toHaveLength(1)
    replaceClipMedia(CLOSE_UP, 'bee')
    const after = project().clips[CLOSE_UP]!
    expect(viewOf(project(), after).name).toBe('clip04_16x9_bee-lavender.webm')
    expect(after).toMatchObject({ assetId: 'bee', effects: glow })
  })
  it('says when the new footage is shorter than the clip, so its last frame holds', () => {
    const clip = start.clips[CLOSE_UP]!
    editor.dispatch({ type: 'clip.trim', clipId: CLOSE_UP, start: clip.start, duration: 12 })
    replaceClipMedia(CLOSE_UP, 'm-tunnel')
    expect(lastToast()?.message).toBe(
      'Replaced “Singer close-up” with “Tunnel lights”. It’s 3.2 s shorter, so its last frame holds at the end.',
    )
  })

  it('takes the clip’s cutout for text behind the subject with the old footage, except one on a locked track', () => {
    editor.dispatch(cutoutCommands(project(), [CLOSE_UP]).commands)
    const [cutout] = cutoutsOf(project(), CLOSE_UP)
    expect(cutout).toBeDefined()
    replaceClipMedia(CLOSE_UP, 'm-city')
    expect(project().clips[cutout!.id]).toBeUndefined()
    expect(lastToast()?.message).toBe(
      'Replaced “Singer close-up” with “Night city”. Its cutout for text behind the subject went with the old footage.',
    )
    editor.undo()
    expect(project().clips[cutout!.id]).toEqual(cutout)

    editor.dispatch({ type: 'track.update', trackId: cutout!.trackId, patch: { locked: true } })
    expect(replaceClipMedia(CLOSE_UP, 'm-city')).toBe(true)
    expect(project().clips[cutout!.id]).toEqual(cutout)
  })

  it('says why there is nothing to replace, and leaves a clip that already shows the footage', () => {
    const why = () => {
      const target = replaceTarget(project(), get().selection)
      return 'why' in target ? target.why : target.clip.id
    }
    selectClips([])
    expect(why()).toBe('Select a video clip or image first')
    selectClips([CLOSE_UP, 'c-s-c1-2'])
    expect(why()).toBe('Select one clip')
    selectClips(['o-title'])
    expect(why()).toBe('Select a video clip or image first')
    selectClips([CLOSE_UP])
    expect(why()).toBe(CLOSE_UP)
    editor.dispatch({ type: 'track.update', trackId: 't-video', patch: { locked: true } })
    expect(why()).toBe('Its track is locked')
    editor.undo()

    const before = project()
    expect(replaceClipMedia(CLOSE_UP, 'm-singer')).toBe(false)
    expect(lastToast()?.message).toBe('It already shows “Singer close-up”')
    expect(project()).toBe(before)
  })
})

describe('a clip with a 3D camera move', () => {
  const image = (id: string, origin: Asset['origin']): Asset => ({
    id,
    kind: 'image',
    name: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 1,
    storageKey: id,
    width: 1920,
    height: 1080,
    origin,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  /** A still with a move whose depth image was made from it, and another photo in the library. */
  const withMove = (): ImageClip => {
    const still = stillClips(project())[0]!
    editor.dispatch([
      { type: 'asset.add', asset: image('depth-1', { type: 'derived', parentAssetId: still.assetId }) },
      { type: 'asset.add', asset: image('beach', { type: 'import' }) },
      {
        type: 'effect.add',
        clipId: still.id,
        index: 0,
        effect: {
          id: 'move',
          effectId: 'camera-3d',
          enabled: true,
          params: {
            depth: { value: 'depth-1' },
            preset: { value: 'dolly-in' },
            progress: { value: 0, keyframes: [{ time: still.duration, value: 1, easing: 'linear' }] },
          },
        },
      },
    ])
    return project().clips[still.id] as ImageClip
  }

  it('keeps the move flat on another photo, without the old photo’s depth, and Undo brings the depth back', () => {
    const before = withMove()
    expect(replaceClipMedia(before.id, 'beach')).toBe(true)
    const after = project().clips[before.id] as ImageClip
    expect(after.effects[0]).toEqual({
      ...before.effects[0],
      params: { ...before.effects[0]!.params, depth: { value: '' } },
    })
    expect(lastToast()?.message).toMatch(
      /\. Its 3D camera move is flat now: choose Add depth under Motion\.$/,
    )
    lastToast()?.action?.run()
    expect(project().clips[before.id]).toEqual(before)
    editor.redo()
    expect(project().clips[before.id]).toEqual(after)
  })

  it('drops the move when a video replaces the photo, and keeps a depth made from another picture', () => {
    const before = withMove()
    replaceClipMedia(before.id, 'm-city')
    expect(project().clips[before.id]).toMatchObject({ type: 'video', effects: before.effects.slice(1) })
    expect(lastToast()?.message).toMatch(
      /\. 3D camera moves are for images, so its move went with the old image\.$/,
    )
    editor.undo()

    editor.dispatch({
      type: 'asset.add',
      asset: image('depth-2', { type: 'derived', parentAssetId: 'beach' }),
    })
    editor.dispatch({
      type: 'clip.set',
      clipId: before.id,
      path: ['effects', 0, 'params', 'depth', 'value'],
      value: 'depth-2',
    })
    replaceClipMedia(before.id, 'beach')
    expect((project().clips[before.id] as ImageClip).effects[0]?.params.depth).toEqual({ value: 'depth-2' })
  })
})

describe('a media card dropped on a clip with Alt held', () => {
  const drag = { dataTransfer: null }
  const at = (alt: boolean) => {
    const clip = start.clips[CLOSE_UP]!
    return { trackId: clip.trackId, time: clip.start + 0.5, pointer: clip.start + 0.5, alt }
  }

  it('shows that Alt replaces, then replaces the clip under the pointer', () => {
    const clip = start.clips[CLOSE_UP]!
    startMediaDrag(drag, 'm-city')
    expect(mediaDropHint(at(false))).toMatchObject({ canReplace: { trackId: clip.trackId, at: clip.start } })
    expect(mediaDropHint(at(true))).toEqual({
      trackId: clip.trackId,
      start: clip.start,
      end: clip.start + clip.duration,
      replace: true,
    })
    dropMedia(drag, at(true))
    expect(project().clips[CLOSE_UP]).toMatchObject({
      assetId: 'm-city',
      start: clip.start,
      duration: clip.duration,
    })
    expect(editor.undoLabel()).toBe('Replace Singer close-up with Night city')
  })

  it('adds the media as usual without Alt, and offers no replace for audio', () => {
    startMediaDrag(drag, 'm-city')
    dropMedia(drag, at(false))
    expect(project().clips[CLOSE_UP]).toMatchObject({ assetId: 'm-singer' })
    expect(editor.undoLabel()).not.toMatch(/^Replace/)
    endMediaDrag()

    startMediaDrag(drag, start.songAssetId!)
    expect(mediaDropHint(at(true))).not.toHaveProperty('replace')
    expect(mediaDropHint(at(true))).not.toHaveProperty('canReplace')
    endMediaDrag()
  })
})
