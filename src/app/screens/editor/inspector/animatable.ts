import { createElement } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { evaluate } from '../../../../engine/animation.ts'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { ParamSpec } from '../../../../engine/types.ts'
import type {
  Animatable,
  Clip,
  ColorAdjustmentKey,
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
import { CAMERA_EFFECT_ID } from '../../../../vision/render/cameraEffect.ts'
import { formatTime } from '../../../format.ts'
import { animatableAt, createAt, keyframeAt, valueAtCommands } from '../../../state/keyframes.ts'
import { dispatch, editor, isLookClip, useProject } from '../../../state/project.ts'
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

/** The react button without a panel turns this reaction on and off. */
const QUICK_REACTION = 'kick'

/** A setting's name for the middle of a sentence ("Amount" to "amount"), keeping acronyms ("LUT strength"). */
export const lowerFirst = (name: string) =>
  /^[A-Z][a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name

/**
 * A setting's full name with what it belongs to: "RGB split amount", without repeating a word where they meet: just
 * "Color grade" for its Grade, and "Film grain size" for its Grain size.
 */
export function settingName(label: string, owner: string): string {
  if (owner.toLowerCase().endsWith(label.toLowerCase())) return owner
  const last = owner.split(' ').at(-1)?.toLowerCase()
  const [first, ...rest] = label.split(' ')
  if (rest.length && first?.toLowerCase() === last) return `${owner} ${lowerFirst(rest.join(' '))}`
  return `${owner} ${lowerFirst(label)}`
}

interface RowOptions {
  /** Where the row reads the clip. */
  project?: Project
  /** The setting's name for the undo label ("Change height"). */
  label?: string
  /** What the setting belongs to, such as an effect, named first in the undo label ("Change RGB split amount"). */
  owner?: string
  /** Where a keyframed property is read and keyed, in timeline seconds. */
  playhead?: Seconds
  /** Properties that take the same edits and keyframes, such as Scale's scaleY with scaleX. */
  linked?: readonly PropertyPath[]
}

/**
 * Binds one animatable clip property to the edit API: value edits coalesce per gesture, the keyframe button (which
 * adds a keyframe at the playhead, or removes the one there), and the react button, which opens the music reactions
 * for the property. A clip that lacks the property shows `fallback` and gets the property on its first edit. Once
 * the property has keyframes, the row shows its value at the playhead, and an edit sets the keyframe there.
 */
export function animatableRow(
  clip: Clip,
  path: PropertyPath,
  fallback?: ParamValue,
  { project = editor.getProject(), label, owner, playhead = get().playhead, linked = [] }: RowOptions = {},
) {
  const named = label && (owner ? settingName(label, owner) : lowerFirst(label))
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
    const existing = keyframeAt(animatableAt(now, path), time)
    if (existing) {
      dispatch(
        paths.flatMap((p): EditCommand[] => {
          const at = keyframeAt(animatableAt(now, p), time)
          return at ? [{ type: 'keyframe.remove', clipId: clip.id, path: p, time: at.time }] : []
        }),
        { label: 'Remove keyframe' },
      )
      toast(`Keyframe removed at ${formatTime(clip.start + existing.time, true)}`)
      return
    }
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
      { label: owner && named ? `Add keyframe: ${named}` : 'Add keyframe' },
    )
    toast(`Keyframe added at ${formatTime(get().playhead, true)}`)
  }
  const set = (value: ParamValue) => {
    const time = keyTime(clip, get().playhead)
    const now = current()
    const own = animatableAt(now, path)
    dispatch(
      paths.flatMap((p) => valueAtCommands(now, p, value, time)),
      { coalesceKey: gesture, label: named && `Change ${named}` },
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
      onReact: target ? react : undefined,
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

/** The color adjustments (-1..1, neutral 0) the Inspector's Color section shows. */
export const ADJUSTMENTS: readonly { key: ColorAdjustmentKey; label: string }[] = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'temperature', label: 'Temperature' },
  { key: 'tint', label: 'Tint' },
  { key: 'hue', label: 'Hue' },
]
/** Shown on every clip; the others only once the clip has them, as a look's temperature. */
export const ALWAYS: ReadonlySet<ColorAdjustmentKey> = new Set(['exposure', 'contrast', 'saturation'])

/** A property with keyframe and react buttons in the Inspector, as animatableRow() takes it. */
export interface ClipProperty {
  path: PropertyPath
  /** Its name in the Inspector's buttons: "Opacity", "RGB split amount". */
  name: string
  fallback?: ParamValue
  options: Omit<RowOptions, 'project' | 'playhead'>
}

const keyable = (spec: ParamSpec) => spec.type === 'number' && spec.animatable !== false

function paramProperties(base: PropertyPath, specs: readonly ParamSpec[], owner?: string): ClipProperty[] {
  return specs.filter(keyable).map((spec) => ({
    path: [...base, spec.key],
    name: owner ? settingName(spec.label, owner) : spec.label,
    fallback: spec.default,
    options: { label: spec.label, owner },
  }))
}

/**
 * The properties of a clip that have keyframe and react buttons in its Inspector, in the Inspector's order, for the
 * command palette's Add a keyframe… and React to music….
 */
export function clipProperties(clip: Clip): ClipProperty[] {
  if (clip.type === 'audio' || (clip.type === 'text' && clip.lyricLineId)) return []
  const transform: ClipProperty[] = [
    { path: ['transform', 'x'], name: 'Position', options: { linked: [['transform', 'y']] } },
    {
      path: ['transform', 'scaleX'],
      name: 'Scale',
      options: { label: 'Scale', linked: [['transform', 'scaleY']] },
    },
    { path: ['transform', 'rotation'], name: 'Rotation', options: {} },
  ]
  if (clip.type === 'text') return transform
  const opacity = (name: string): ClipProperty => ({ path: ['opacity'], name, options: { label: name } })
  if (clip.type === 'generator') {
    const params = pluginRegistry.get(clip.generatorId)?.params ?? []
    return [...paramProperties(['params'], params), opacity('Opacity')]
  }
  const color = ADJUSTMENTS.filter((a) => ALWAYS.has(a.key) || clip.adjustments?.[a.key]).map(
    (a): ClipProperty => ({
      path: ['adjustments', a.key],
      name: a.label,
      fallback: 0,
      options: { label: a.label },
    }),
  )
  const effects = clip.effects.flatMap((fx, index) => {
    const def = pluginRegistry.get(fx.effectId)
    if (fx.effectId === CAMERA_EFFECT_ID || !def) return []
    return paramProperties(['effects', index, 'params'], def.params, def.name)
  })
  if (clip.type === 'adjustment')
    return [opacity(isLookClip(clip) ? 'Look intensity' : 'Intensity'), ...color, ...effects]
  return [...transform, opacity('Opacity'), ...color, ...effects]
}
