import type {
  Animatable,
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

/**
 * The command that gives the clip the property at `path` with `value`, or null when the clip has it. Older projects
 * can lack a plugin parameter, and a clip has no color adjustment until one is changed.
 */
export function createAt(clip: Clip, path: PropertyPath, value: ParamValue): EditCommand | null {
  let node: unknown = clip
  for (let i = 0; i < path.length; i++) {
    const next = (node as Record<string | number, unknown>)[path[i] as string | number]
    if (next === undefined || next === null) {
      let created: unknown = { value }
      for (let j = path.length - 1; j > i; j--) created = { [path[j] as string]: created }
      return { type: 'clip.set', clipId: clip.id, path: path.slice(0, i + 1), value: created }
    }
    node = next
  }
  return null
}

export function animatableAt(clip: Clip, path: PropertyPath): Animatable<ParamValue> | undefined {
  let node: unknown = clip
  for (const k of path) node = (node as Record<string | number, unknown> | undefined)?.[k]
  return node as Animatable<ParamValue> | undefined
}

/** Keyframes this close to a time, in seconds, are the keyframe at that time. */
const AT_KEYFRAME = 0.005

export const keyframeAt = (anim: Animatable<ParamValue> | undefined, time: Seconds) =>
  anim?.keyframes?.find((k) => Math.abs(k.time - time) < AT_KEYFRAME)

/**
 * Commands that make the clip's property at `path` draw `value` at clip-local `time`. On a keyframed property that is
 * the keyframe at `time` (the one there keeps its time and easing, a new one eases in and out), since the value under
 * the keyframes is not what is drawn; otherwise the value itself, creating the property if the clip lacks it.
 */
export function valueAtCommands(
  clip: Clip,
  path: PropertyPath,
  value: ParamValue,
  time: Seconds,
): EditCommand[] {
  const anim = animatableAt(clip, path)
  if (!anim?.keyframes?.length)
    return [
      createAt(clip, path, value) ?? { type: 'clip.set', clipId: clip.id, path: [...path, 'value'], value },
    ]
  const at = keyframeAt(anim, time)
  return [
    {
      type: 'keyframe.set',
      clipId: clip.id,
      path,
      keyframe: { time: at?.time ?? time, value, easing: at?.easing ?? 'ease-in-out' },
    },
  ]
}

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

/**
 * Diamonds closer than this (px) touch, so their keyframes share one mark: a diamond is an 8 px square turned 45°,
 * about 11.3 px wide, 13 px with its outline.
 */
export const MARK_OVERLAP = 12

/** Half a diamond's width with its outline (px). */
const DIAMOND_HALF = 6.5

/**
 * Where a group's count ends, in px right of its diamond: it starts 7 px right of the diamond (`.keyframeCount` in
 * Timeline.module.css), with 3 px padding and a 1 px ring each side, and its tabular figures stay under 7 px each.
 */
export const countEnd = (count: number): number => 7 + 8 + 7 * String(count).length

/**
 * Keyframes that share one mark on the timeline: its diamond (and count) at the first one, `at`, and the last one's
 * diamond at `end` (px over the clip).
 */
export interface MarkGroup {
  marks: KeyframeMark[]
  at: number
  end: number
}

/**
 * The marks as drawn, given their diamonds' positions `at` (px over the clip, in order): a mark whose diamond sits
 * closer than `gap` to the previous one, or would land on the group's count, joins its group. So dense keyframes (a
 * VJ take's strobe) become one mark instead of a pile where only the top diamond can be clicked, and no diamond
 * covers a count.
 */
export function groupMarks(
  marks: readonly KeyframeMark[],
  at: readonly number[],
  gap = MARK_OVERLAP,
): MarkGroup[] {
  const groups: MarkGroup[] = []
  marks.forEach((mark, i) => {
    const x = at[i] ?? 0
    const group = groups.at(-1)
    const count = group?.marks.length ?? 0
    const onCount = count > 1 && x - DIAMOND_HALF < group!.at + countEnd(count)
    if (group && (x - group.end < gap || onCount)) {
      group.marks.push(mark)
      group.end = x
    } else groups.push({ marks: [mark], at: x, end: x })
  })
  return groups
}

function marksAt(clipId: Id, times: readonly Seconds[]) {
  const clip = editor.getProject().clips[clipId]
  if (!clip) return null
  const marks = keyframeMarks(clip).filter((m) => isAt(times, m.time))
  return marks.length ? { clip, marks } : null
}

const isAt = (times: readonly Seconds[], time: Seconds) => times.some((t) => Math.abs(t - time) < SAME_TIME)

/** Gives every keyframe of the clip at `times` the easing, as one undo step. */
export function setKeyframeEasing(
  clipId: Id,
  times: readonly Seconds[],
  easing: Exclude<Easing, object>,
): void {
  const found = marksAt(clipId, times)
  if (!found) return
  const commands: EditCommand[] = []
  for (const { path, keyframes } of keyedProperties(found.clip))
    for (const k of keyframes)
      if (isAt(times, k.time))
        commands.push({ type: 'keyframe.set', clipId, path, keyframe: { ...k, easing } })
  const label = EASINGS.find((e) => e.value === easing)?.label ?? easing
  dispatch(commands, { label: `Keyframe easing: ${label}` })
}

/** Removes every keyframe of the clip at `times`, as one undo step. */
export function removeKeyframes(clipId: Id, times: readonly Seconds[]): void {
  const found = marksAt(clipId, times)
  if (!found) return
  const { clip, marks } = found
  const label = marks.length > 1 ? 'Remove keyframes' : 'Remove keyframe'
  const commands = marks.flatMap((mark) =>
    mark.paths.map((path): EditCommand => ({ type: 'keyframe.remove', clipId, path, time: mark.time })),
  )
  if (!dispatch(commands, { label })) return
  const first = formatTime(clip.start + marks[0]!.time, true)
  toast(
    marks.length > 1
      ? `${marks.length} keyframes removed, ${first} to ${formatTime(clip.start + marks.at(-1)!.time, true)}`
      : `Keyframe removed at ${first}`,
    undoAction(label),
  )
}
