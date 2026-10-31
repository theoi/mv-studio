import { createElement } from 'react'
import type { Animatable, Clip, ParamValue, PropertyPath } from '../../../../model/index.ts'
import {
  canReact,
  describeReaction,
  reactionCommands,
  removeReactionCommands,
  type ReactionTarget,
  type ReactiveClipProperty,
} from '../../../../plugins/reactions.ts'
import { formatTime } from '../../../format.ts'
import { dispatch, editor } from '../../../state/project.ts'
import { get, toast } from '../../../state/ui.ts'
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

/** The react button without a panel turns this reaction on and off. */
const QUICK_REACTION = 'kick'

/**
 * Binds one animatable clip property to the edit API: value edits coalesce per gesture, the keyframe button, and the
 * react button, which opens the music reactions for the property. Spread `buttons` into AnimateButtons.
 */
export function useAnimatable(clip: Clip, path: PropertyPath) {
  let node: unknown = clip
  for (const k of path) node = (node as Record<string | number, unknown> | undefined)?.[k]
  const anim = node as Animatable<ParamValue> | undefined
  const gesture = `inspector:${clip.id}:${path.join('.')}`
  const project = editor.getProject()
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
  const key = () => {
    const time = Math.max(0, get().playhead - clip.start)
    dispatch({
      type: 'keyframe.set',
      clipId: clip.id,
      path,
      keyframe: { time, value: anim?.value ?? 0, easing: 'ease-in-out' },
    })
    toast(`Keyframe added at ${formatTime(get().playhead, true)}`)
  }
  const react = () => {
    if (!target) return
    const p = editor.getProject()
    if (reactive) dispatch(removeReactionCommands(p, [target]), { label: 'Stop reacting to music' })
    else dispatch(reactionCommands(p, [target], QUICK_REACTION), { label: 'React to music: Pulse with kick' })
  }
  return {
    value: anim?.value,
    keyed: !!anim?.keyframes?.length,
    reactive,
    reaction,
    set: (value: ParamValue) =>
      dispatch(
        { type: 'clip.set', clipId: clip.id, path: [...path, 'value'], value },
        { coalesceKey: gesture },
      ),
    commit: () => editor.endGesture(),
    key,
    react,
    buttons: {
      keyed: !!anim?.keyframes?.length,
      reactive,
      reaction,
      onKey: key,
      onReact: react,
      reactPanel: target ? createElement(ReactPanel, { target }) : undefined,
    },
  }
}
