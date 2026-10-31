import type {
  Clip,
  Easing,
  EditCommand,
  Id,
  Keyframe,
  ParamValue,
  PropertyPath,
  Seconds,
} from '../../model/index.ts'
import { formatTime } from '../format.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

const undoAction = (label: string) => ({
  label: 'Undo',
  run: () => {
    if (editor.undoLabel() === label) editor.undo()
  },
})

/** The easings offered for a keyframe, in menu order. Custom curves made elsewhere show with none checked. */
export const EASINGS: { value: Exclude<Easing, object>; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in and out' },
  { value: 'hold', label: 'Hold' },
]

/** Keyframes of one clip at one time (clip-local seconds), on every property keyed there. */
export interface KeyframeMark {
  time: Seconds
  paths: PropertyPath[]
  /** The easing they share, or null when they differ or use a custom curve. */
  easing: Exclude<Easing, object> | null
  /** Some property keyed here has a later keyframe; without one, the easing has nothing to ease toward. */
  hasNext: boolean
}

const SAME_TIME = 1e-6

interface Keyed {
  path: PropertyPath
  keyframes: Keyframe<ParamValue>[]
}

/** Every animatable property of the clip that has keyframes, wherever it is (transform, effects, params...). */
function keyedProperties(clip: Clip): Keyed[] {
  const out: Keyed[] = []
  const walk = (node: unknown, path: PropertyPath) => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i]))
      return
    }
    const record = node as Record<string, unknown>
    if ('value' in record && Array.isArray(record.keyframes)) {
      if (record.keyframes.length) out.push({ path, keyframes: record.keyframes as Keyed['keyframes'] })
      return
    }
    for (const [key, child] of Object.entries(record)) walk(child, [...path, key])
  }
  walk(clip, [])
  return out
}

/** The clip's keyframes grouped by time, earliest first. */
export function keyframeMarks(clip: Clip): KeyframeMark[] {
  const marks: (KeyframeMark & { easings: Easing[] })[] = []
  for (const { path, keyframes } of keyedProperties(clip))
    for (const k of keyframes) {
      let mark = marks.find((m) => Math.abs(m.time - k.time) < SAME_TIME)
      if (!mark) marks.push((mark = { time: k.time, paths: [], easing: null, hasNext: false, easings: [] }))
      mark.paths.push(path)
      mark.easings.push(k.easing)
      if (keyframes.some((x) => x.time > k.time + SAME_TIME)) mark.hasNext = true
    }
  return marks
    .map(({ easings, ...m }) => {
      const first = easings[0]
      const same = typeof first === 'string' && easings.every((e) => e === first)
      return { ...m, easing: same ? first : null }
    })
    .sort((a, b) => a.time - b.time)
}

/**
 * Where each keyframe mark takes clicks, in px over the clip, given its diamond's position `at` (in order): up to
 * 24 px wide around the diamond, ending halfway to a neighboring diamond so the nearest one always wins, and at most
 * 8 px past the clip's ends.
 */
export function markTargets(at: readonly number[], clipWidth: number): { left: number; width: number }[] {
  return at.map((x, i) => {
    const prev = at[i - 1]
    const next = at[i + 1]
    const left = Math.max(x - 12, prev === undefined ? -8 : (prev + x) / 2)
    const right = Math.min(x + 12, next === undefined ? clipWidth + 8 : (x + next) / 2)
    return { left, width: Math.max(0, right - left) }
  })
}

function markOf(clipId: Id, time: Seconds) {
  const clip = editor.getProject().clips[clipId]
  const mark = clip && keyframeMarks(clip).find((m) => Math.abs(m.time - time) < SAME_TIME)
  return clip && mark ? { clip, mark } : null
}

/** Gives every keyframe of the clip at `time` the easing, as one undo step. */
export function setKeyframeEasing(clipId: Id, time: Seconds, easing: Exclude<Easing, object>): void {
  const found = markOf(clipId, time)
  if (!found) return
  const commands: EditCommand[] = []
  for (const { path, keyframes } of keyedProperties(found.clip)) {
    const k = keyframes.find((x) => Math.abs(x.time - time) < SAME_TIME)
    if (k) commands.push({ type: 'keyframe.set', clipId, path, keyframe: { ...k, easing } })
  }
  const label = EASINGS.find((e) => e.value === easing)?.label ?? easing
  dispatch(commands, { label: `Keyframe easing: ${label}` })
}

/** Removes every keyframe of the clip at `time`, as one undo step. */
export function removeKeyframes(clipId: Id, time: Seconds): void {
  const found = markOf(clipId, time)
  if (!found) return
  const label = 'Remove keyframe'
  if (
    dispatch(
      found.mark.paths.map((path) => ({ type: 'keyframe.remove', clipId, path, time: found.mark.time })),
      { label },
    )
  )
    toast(`Keyframe removed at ${formatTime(found.clip.start + found.mark.time, true)}`, undoAction(label))
}
