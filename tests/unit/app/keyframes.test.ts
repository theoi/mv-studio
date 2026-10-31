import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Clip } from '../../../src/model/index.ts'
import { animatableRow } from '../../../src/app/screens/editor/inspector/animatable.ts'
import { formatTime } from '../../../src/app/format.ts'
import {
  countEnd,
  groupMarks,
  keyframeMarks,
  markTargets,
  removeKeyframes,
  setKeyframeEasing,
} from '../../../src/app/state/keyframes.ts'
import { editor, loadDemoProject } from '../../../src/app/state/project.ts'
import { get, set } from '../../../src/app/state/ui.ts'

beforeEach(() => loadDemoProject())
// Toasts time themselves out with window.setTimeout.
beforeEach(() => vi.stubGlobal('window', { setTimeout: () => 0 }))
afterEach(() => vi.unstubAllGlobals())

/** A demo text clip with keyframes on opacity at 0 and 1 s and on x at 1 s (ease-out) and 2 s. */
function keyedClip(): Clip {
  const clip = Object.values(editor.getProject().clips).find((c) => c.type === 'text')
  if (!clip) throw new Error('The demo project has no text clip')
  editor.dispatch([
    {
      type: 'keyframe.set',
      clipId: clip.id,
      path: ['opacity'],
      keyframe: { time: 0, value: 0, easing: 'linear' },
    },
    {
      type: 'keyframe.set',
      clipId: clip.id,
      path: ['opacity'],
      keyframe: { time: 1, value: 1, easing: 'linear' },
    },
    {
      type: 'keyframe.set',
      clipId: clip.id,
      path: ['transform', 'x'],
      keyframe: { time: 1, value: 0.4, easing: 'ease-out' },
    },
    {
      type: 'keyframe.set',
      clipId: clip.id,
      path: ['transform', 'x'],
      keyframe: { time: 2, value: 0.6, easing: 'linear' },
    },
  ])
  return editor.getProject().clips[clip.id]!
}

const easings = (clipId: string, time: number) =>
  keyframeMarks(editor.getProject().clips[clipId]!).find((m) => m.time === time)?.easing

it('groups a clip’s keyframes by time across its properties', () => {
  const marks = keyframeMarks(keyedClip())
  expect(marks.map((m) => [m.time, m.paths.length, m.easing])).toEqual([
    [0, 1, 'linear'],
    [1, 2, null],
    [2, 1, 'linear'],
  ])
  // At 1 s opacity has no later keyframe but x does; nothing follows 2 s, so its easing has nothing to ease toward.
  expect(marks.map((m) => m.hasNext)).toEqual([true, true, false])
})

it('sets the easing of every keyframe at a time as one undo step', () => {
  const clip = keyedClip()
  setKeyframeEasing(clip.id, [1], 'hold')
  expect(easings(clip.id, 1)).toBe('hold')
  expect(easings(clip.id, 0)).toBe('linear')
  editor.undo()
  expect(easings(clip.id, 1)).toBeNull()
})

it('removes every keyframe at a time as one undo step, keeping the rest', () => {
  const clip = keyedClip()
  removeKeyframes(clip.id, [1])
  expect(keyframeMarks(editor.getProject().clips[clip.id]!).map((m) => m.time)).toEqual([0, 2])
  // The toast's Undo brings them back.
  get().toasts.at(-1)?.action?.run()
  expect(keyframeMarks(editor.getProject().clips[clip.id]!).map((m) => m.time)).toEqual([0, 1, 2])
})

it('the keyframe button removes the keyframe at the playhead and adds one elsewhere', () => {
  const clip = keyedClip()
  const current = () => editor.getProject().clips[clip.id]!
  const opacityTimes = () => {
    const c = current()
    return c.type === 'audio' ? [] : (c.opacity.keyframes ?? []).map((k) => k.time)
  }
  set({ playhead: clip.start + 1 })
  animatableRow(current(), ['opacity']).key()
  expect(opacityTimes()).toEqual([0])
  set({ playhead: clip.start + 1.5 })
  animatableRow(current(), ['opacity']).key()
  expect(opacityTimes()).toEqual([0, 1.5])
})

it('a keyframe mark takes clicks up to 12 px either side, halfway to a close neighbor, and 8 px past the clip', () => {
  // Alone: 24 px centered on the diamond.
  expect(markTargets([50], 200)).toEqual([{ left: 38, width: 24 }])
  // 10 px apart: each stops at the midpoint, so a click 3 px right of the first diamond is on the first mark.
  expect(markTargets([50, 60, 100], 200)).toEqual([
    { left: 38, width: 17 },
    { left: 55, width: 17 },
    { left: 88, width: 24 },
  ])
  // On a clip narrower than 16 px the diamonds sit near its ends, and the areas reach at most 8 px past them.
  expect(markTargets([2], 10)).toEqual([{ left: -8, width: 22 }])
  expect(markTargets([8], 10)).toEqual([{ left: -4, width: 22 }])
})

it('keyframes whose diamonds touch share one mark at the first of them, chained from diamond to diamond', () => {
  const marks = keyframeMarks(keyedClip())
  // 0, 1 and 2 s drawn 3 px apart: one mark at the first, reaching to the last.
  expect(groupMarks(marks, [10, 13, 16]).map((g) => [g.marks.map((m) => m.time), g.at, g.end])).toEqual([
    [[0, 1, 2], 10, 16],
  ])
  // Each 11 px from the last: still one, though the ends are 22 px apart.
  expect(groupMarks(marks, [10, 21, 32]).map((g) => g.marks.length)).toEqual([3])
  // Zoomed in, 12 px apart and more, every keyframe has its own mark.
  expect(groupMarks(marks, [10, 22, 60]).map((g) => [g.marks.map((m) => m.time), g.at, g.end])).toEqual([
    [[0], 10, 10],
    [[1], 22, 22],
    [[2], 60, 60],
  ])
})

it('a diamond that would cover a group’s count joins the group', () => {
  const marks = keyframeMarks(keyedClip())
  // Two keyframes 3 px apart show "2" from 17 to 32 px; a diamond 13 px wide at 36 px would cover it.
  expect(countEnd(2)).toBe(22)
  expect(groupMarks(marks, [10, 13, 36]).map((g) => g.marks.length)).toEqual([3])
  // At 40 px it is clear of the count.
  expect(groupMarks(marks, [10, 13, 40]).map((g) => g.marks.map((m) => m.time))).toEqual([[0, 1], [2]])
})

it('sets the easing of and removes a whole group as one undo step each, with the count in the toast', () => {
  const clip = keyedClip()
  const times = () => keyframeMarks(editor.getProject().clips[clip.id]!).map((m) => m.time)
  setKeyframeEasing(clip.id, [0, 1], 'hold')
  expect([easings(clip.id, 0), easings(clip.id, 1), easings(clip.id, 2)]).toEqual(['hold', 'hold', 'linear'])
  editor.undo()
  expect(easings(clip.id, 0)).toBe('linear')
  removeKeyframes(clip.id, [0, 1])
  expect(times()).toEqual([2])
  expect(editor.undoLabel()).toBe('Remove keyframes')
  const toastMessage = get().toasts.at(-1)?.message
  expect(toastMessage).toBe(
    `2 keyframes removed, ${formatTime(clip.start, true)} to ${formatTime(clip.start + 1, true)}`,
  )
  get().toasts.at(-1)?.action?.run()
  expect(times()).toEqual([0, 1, 2])
})
