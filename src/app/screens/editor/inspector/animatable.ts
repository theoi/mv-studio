import { createElement } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { evaluate } from '../../../../engine/animation.ts'
import type {
  Animatable,
  Clip,
  EditCommand,
  ParamValue,
  Project,
  PropertyPath,
  Seconds,
} from '../../../../model/index.ts'
import {
  canReact,
  describeReaction,
  reactionCommands,
  removeReactionCommands,
  type ReactionTarget,
  type ReactiveClipProperty,
} from '../../../../plugins/reactions.ts'
import { formatTime } from '../../../format.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
import { get, toast, useUi } from '../../../state/ui.ts'
import { ReactPanel } from './ReactPanel.tsx'

const TRANSFORM: Record<string, ReactiveClipProperty> = {
  x: 'x',
  y: 'y',
  scaleX: 'scale',
  scaleY: 'scale',
  rotation: 'rotation',
}

/** What reacts to the music when the react button of the property at `path` is used, or null if nothing can. */
export function reactionTarget(clip: Clip, path: PropertyPath): ReactionTarget | null {
  const [head, key, sub, param] = path
  if (head === 'opacity' && path.length === 1) return { clipId: clip.id, property: 'opacity' }
  if (path.length === 2 && typeof key === 'string') {
    if (head === 'transform') return TRANSFORM[key] ? { clipId: clip.id, property: TRANSFORM[key] } : null
    if (head === 'adjustments')
      return { clipId: clip.id, property: `adjustments.${key}` as ReactiveClipProperty }
    if (head === 'params') return { clipId: clip.id, param: key }
  }
  if (head === 'effects' && typeof key === 'number' && sub === 'params' && typeof param === 'string') {
    const effect = clip.type === 'audio' ? undefined : clip.effects[key]
    return effect ? { clipId: clip.id, effectInstanceId: effect.id, param } : null
  }
  return null
}

/**
 * The command that gives the clip the property at `path` with `value`, or null when the clip has it. Older projects
 * can lack a plugin parameter, and a clip has no color adjustment until one is changed.
 */
function createAt(clip: Clip, path: PropertyPath, value: ParamValue): EditCommand | null {
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

function animatableAt(clip: Clip, path: PropertyPath): Animatable<ParamValue> | undefined {
  let node: unknown = clip
  for (const k of path) node = (node as Record<string | number, unknown> | undefined)?.[k]
  return node as Animatable<ParamValue> | undefined
}

/** Keyframes this close to a time, in seconds, are the keyframe at that time. */
const AT_KEYFRAME = 0.005

const keyframeAt = (anim: Animatable<ParamValue> | undefined, time: Seconds) =>
  anim?.keyframes?.find((k) => Math.abs(k.time - time) < AT_KEYFRAME)

/** Where a keyframe set at the playhead goes, in clip-local seconds. */
const keyTime = (clip: Clip, playhead: Seconds) => Math.max(0, playhead - clip.start)

/** What a row shows: a keyframed property's value at clip-local `time`, else its value, else `fallback`. */
function shownValue(
  anim: Animatable<ParamValue> | undefined,
  fallback: ParamValue | undefined,
  time: Seconds,
) {
  return anim?.keyframes?.length ? evaluate(anim, time) : (anim?.value ?? fallback)
}

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

/** The react button without a panel turns this reaction on and off. */
const QUICK_REACTION = 'kick'

interface RowOptions {
  /** Where the row reads the clip. */
  project?: Project
  /** The setting's name for the undo label ("Change height"). */
  label?: string
  /** Where a keyframed property is read and keyed, in timeline seconds. */
  playhead?: Seconds
  /** Properties that take the same edits and keyframes, such as Scale's scaleY with scaleX. */
  linked?: readonly PropertyPath[]
}

/**
 * Binds one animatable clip property to the edit API: value edits coalesce per gesture, the keyframe button, and the
 * react button, which opens the music reactions for the property. A clip that lacks the property shows `fallback`
 * and gets the property on its first edit. Once the property has keyframes, the row shows its value at the playhead,
 * and an edit sets the keyframe there.
 */
export function animatableRow(
  clip: Clip,
  path: PropertyPath,
  fallback?: ParamValue,
  { project = editor.getProject(), label, playhead = get().playhead, linked = [] }: RowOptions = {},
) {
  const anim = animatableAt(clip, path)
  const paths = [path, ...linked]
  const gesture = `inspector:${clip.id}:${path.join('.')}`
  const found = reactionTarget(clip, path)
  const target = found && canReact(project, found) ? found : null
  const active = target ? describeReaction(project, target) : null
  const reactive = !!anim?.modulation?.length
  const reaction =
    active?.kind === 'reaction'
      ? active.listensTo === active.reaction.label
        ? active.summary
        : `${active.summary} · ${active.listensTo}`
      : active
        ? 'Custom mapping'
        : undefined
  const current = () => editor.getProject().clips[clip.id] ?? clip
  const key = () => {
    const time = keyTime(clip, get().playhead)
    const now = current()
    dispatch(
      paths.flatMap((p): EditCommand[] => {
        const value = shownValue(animatableAt(now, p), fallback, time) ?? 0
        const create = createAt(now, p, value)
        return [
          ...(create ? [create] : []),
          {
            type: 'keyframe.set',
            clipId: clip.id,
            path: p,
            keyframe: { time, value, easing: 'ease-in-out' },
          },
        ]
      }),
      { label: 'Add keyframe' },
    )
    toast(`Keyframe added at ${formatTime(get().playhead, true)}`)
  }
  const set = (value: ParamValue) => {
    const time = keyTime(clip, get().playhead)
    const now = current()
    const own = animatableAt(now, path)
    dispatch(
      paths.flatMap((p) => valueAtCommands(now, p, value, time)),
      { coalesceKey: gesture, label: label && `Change ${label.charAt(0).toLowerCase()}${label.slice(1)}` },
    )
    if (own?.keyframes?.length && !keyframeAt(own, time))
      toast(`Keyframe added at ${formatTime(clip.start + time, true)}`)
  }
  const react = () => {
    if (!target) return
    const p = editor.getProject()
    if (reactive) dispatch(removeReactionCommands(p, [target]), { label: 'Stop reacting to music' })
    else dispatch(reactionCommands(p, [target], QUICK_REACTION), { label: 'React to music: Pulse with kick' })
  }
  return {
    value: shownValue(anim, fallback, keyTime(clip, playhead)),
    keyed: !!anim?.keyframes?.length,
    reactive,
    reaction,
    set,
    commit: () => editor.endGesture(),
    key,
    react,
    buttons: {
      keyed: !!anim?.keyframes?.length,
      keyAtPlayhead: !!keyframeAt(anim, keyTime(clip, playhead)),
      reactive,
      reaction,
      onKey: key,
      onReact: react,
      reactPanel: target ? createElement(ReactPanel, { target }) : undefined,
    },
  }
}

/**
 * animatableRow() for an inspector row, re-rendered by project changes that affect the react button, such as stems
 * finishing separation, and by the playhead while the property has keyframes. Spread `buttons` into AnimateButtons.
 */
export function useAnimatable(
  clip: Clip,
  path: PropertyPath,
  fallback?: ParamValue,
  options: Omit<RowOptions, 'project' | 'playhead'> = {},
) {
  const row = animatableRow(clip, path, fallback, { ...options, project: useProject() })
  const anim = animatableAt(clip, path)
  // Only a keyframed value changes with the playhead; shallow equality keeps colors and vectors from re-rendering.
  const value = useUi(useShallow((s) => shownValue(anim, fallback, keyTime(clip, s.playhead))))
  const keyAtPlayhead = useUi((s) => !!keyframeAt(anim, keyTime(clip, s.playhead)))
  return { ...row, value, buttons: { ...row.buttons, keyAtPlayhead } }
}
