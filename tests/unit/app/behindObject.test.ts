import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Clip, Project } from '../../../src/model/index.ts'
import { cutoutCommands, cutoutsOf, objectOf, type ObjectPick } from '../../../src/app/state/behind.ts'
import {
  footageAt,
  mediaTimeOf,
  objectCutoutCommands,
  timelineTimeOf,
} from '../../../src/app/state/behindObject.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'

type VideoClip = Extract<Clip, { type: 'video' }>

beforeEach(() => loadDemoProject())

const singer = (project: Project = editor.getProject()) =>
  Object.values(project.clips)
    .filter((c): c is VideoClip => c.type === 'video' && c.assetId === 'm-singer' && !c.meta?.behindSubjectOf)
    .sort((a, b) => a.start - b.start)[0]!

const mask: Asset = {
  id: 'mask-object',
  kind: 'video',
  name: 'object mask',
  mimeType: 'video/webm',
  byteSize: 100,
  storageKey: 'opfs/mask-object',
  origin: { type: 'derived', parentAssetId: 'm-singer', provider: 'vision.object-mask' },
  createdAt: new Date(0).toISOString(),
}

const pick: ObjectPick = {
  click: { t: 3.2, points: [{ x: 0.4, y: 0.6 }] },
  corrections: [],
  tracked: 0.8,
  fix: [5.5],
}

describe('picking footage on the canvas', () => {
  it('maps a canvas point through the clip transform into the footage frame', () => {
    const clip = singer()
    const time = clip.start + 0.5
    editor.dispatch([
      { type: 'clip.set', clipId: clip.id, path: ['fit'], value: 'stretch' },
      { type: 'clip.set', clipId: clip.id, path: ['transform', 'x'], value: { value: 0.25 } },
      { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleX'], value: { value: 0.5 } },
      { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleY'], value: { value: 0.5 } },
    ])
    const project = editor.getProject()
    const hit = footageAt(project, { x: 0.125, y: 0.5 }, time)
    expect(hit?.clip.id).toBe(clip.id)
    expect(hit?.point.x).toBeCloseTo(0.25)
    expect(hit?.point.y).toBeCloseTo(0.5)
    expect(hit?.mediaTime).toBeCloseTo(clip.sourceStart + 0.5 * clip.playbackRate)
    expect(footageAt(project, { x: 0.75, y: 0.5 }, time, clip.id)).toBeUndefined()
    expect(
      footageAt(project, { x: 0.125, y: 0.5 }, clip.start + clip.duration + 0.01, clip.id),
    ).toBeUndefined()
  })

  it('looks through a cutout to the clip it was made from', () => {
    const clip = singer()
    editor.dispatch(cutoutCommands(editor.getProject(), [clip.id]).commands)
    const hit = footageAt(editor.getProject(), { x: 0.5, y: 0.5 }, clip.start + 0.2)
    expect(hit?.clip.id).toBe(clip.id)
  })

  it('converts between footage time and the timeline, kept inside the clip', () => {
    const clip = { ...singer(), sourceStart: 2, playbackRate: 2 }
    const t = clip.start + 0.75
    expect(mediaTimeOf(clip, t)).toBeCloseTo(3.5)
    expect(timelineTimeOf(clip, 3.5)).toBeCloseTo(t)
    expect(timelineTimeOf(clip, 0)).toBe(clip.start)
    expect(timelineTimeOf(clip, 1e6)).toBeLessThan(clip.start + clip.duration)
  })
})

describe('object cutout commands', () => {
  it('add a cutout that follows the object, with the pick kept on it, as one undo step', () => {
    const before = editor.getProject()
    const clip = singer(before)
    editor.dispatch(objectCutoutCommands(before, clip.id, mask, pick))
    const after = editor.getProject()
    const [cut] = cutoutsOf(after, clip.id)
    expect(after.tracks[0]?.name).toBe('Subject')
    expect(cut).toMatchObject({
      trackId: after.tracks[0]!.id,
      matte: { maskAssetId: mask.id, sourceAssetId: 'm-singer', mode: 'inside' },
    })
    expect(objectOf(cut)).toEqual(pick)
    expect(after.assets[mask.id]).toEqual(mask)
    editor.undo()
    expect(editor.getProject()).toEqual(before)
  })

  it('switch an existing person cutout to the object instead of adding another', () => {
    const clip = singer()
    editor.dispatch(cutoutCommands(editor.getProject(), [clip.id]).commands)
    const withPerson = editor.getProject()
    const personMatte = (cutoutsOf(withPerson, clip.id)[0] as VideoClip).matte
    editor.dispatch(objectCutoutCommands(withPerson, clip.id, mask, pick))
    const cuts = cutoutsOf(editor.getProject(), clip.id)
    expect(cuts).toHaveLength(1)
    expect((cuts[0] as VideoClip).matte?.maskAssetId).toBe(mask.id)
    expect(objectOf(cuts[0])).toEqual(pick)

    editor.undo()
    const back = cutoutsOf(editor.getProject(), clip.id)
    expect((back[0] as VideoClip).matte).toEqual(personMatte)
    expect(objectOf(back[0])).toBeUndefined()
  })

  it('do nothing for a clip that is gone or is not footage', () => {
    const project = editor.getProject()
    expect(objectCutoutCommands(project, 'no-such-clip', mask, pick)).toEqual([])
    const text = Object.values(project.clips).find((c) => c.type === 'text')!
    expect(objectCutoutCommands(project, text.id, mask, pick)).toEqual([])
  })
})
