import type { Animatable, AudioModulation, Clip, ParamValue, PropertyPath } from '../../../../model/index.ts'
import { formatTime } from '../../../format.ts'
import { dispatch, editor } from '../../../state/project.ts'
import { get, toast } from '../../../state/ui.ts'

const DRUM_PULSE: AudioModulation = {
  source: { kind: 'onset', stem: 'drums' },
  amount: 0.15,
  mode: 'add',
  smoothing: 0.3,
}

/** Binds one animatable clip property to the edit API: value edits coalesce per gesture, plus keyframe and react buttons. */
export function useAnimatable(clip: Clip, path: PropertyPath) {
  let node: unknown = clip
  for (const k of path) node = (node as Record<string | number, unknown> | undefined)?.[k]
  const anim = node as Animatable<ParamValue> | undefined
  const key = `inspector:${clip.id}:${path.join('.')}`
  return {
    value: anim?.value,
    keyed: !!anim?.keyframes?.length,
    reactive: !!anim?.modulation?.length,
    set: (value: ParamValue) =>
      dispatch({ type: 'clip.set', clipId: clip.id, path: [...path, 'value'], value }, { coalesceKey: key }),
    commit: () => editor.endGesture(),
    key: () => {
      const time = Math.max(0, get().playhead - clip.start)
      dispatch({
        type: 'keyframe.set',
        clipId: clip.id,
        path,
        keyframe: { time, value: anim?.value ?? 0, easing: 'ease-in-out' },
      })
      toast(`Keyframe added at ${formatTime(get().playhead, true)}`)
    },
    react: () =>
      dispatch(
        {
          type: 'clip.set',
          clipId: clip.id,
          path: [...path, 'modulation'],
          value: anim?.modulation?.length ? [] : [DRUM_PULSE],
        },
        { label: 'React to music' },
      ),
  }
}
