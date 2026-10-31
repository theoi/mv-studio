import { Blend, Trash2 } from 'lucide-react'
import { pluginRegistry } from '../../../../engine/registry.ts'
import type { Easing } from '../../../../model/index.ts'
import { Button } from '../../../ds/Button.tsx'
import { FieldRow, Section, Select, Slider } from '../../../ds/Fields.tsx'
import { editor, useProject, viewOf } from '../../../state/project.ts'
import {
  changeTransitionKind,
  maxTransitionDuration,
  removeTransition,
  setTransitionDuration,
  setTransitionEasing,
  transitionOf,
  transitionSpots,
  type TransitionEdge,
} from '../../../state/transitions.ts'
import { Header } from './parts.tsx'
import styles from '../Inspector.module.css'

type EasingChoice = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

const EASINGS: { value: EasingChoice; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in and out' },
]

const easingChoice = (e: Easing): EasingChoice | 'custom' =>
  typeof e === 'string' && e !== 'hold' ? e : 'custom'

const seconds = (s: number) => `${Number(s.toFixed(2))} s`

/** Inspector › Transition: the transition at a cut, or into or out of a clip. */
export function TransitionInspector({ clipId, edge }: { clipId: string; edge: TransitionEdge }) {
  const project = useProject()
  const clip = project.clips[clipId]
  const transition = transitionOf(clip, edge)
  if (!clip || !transition) return null
  const spot = transitionSpots(project, clip.trackId).find((s) => s.clipId === clipId && s.edge === edge)
  const from = spot?.fromId ? project.clips[spot.fromId] : undefined
  const name = viewOf(project, clip).name
  const meta = from
    ? `Between “${viewOf(project, from).name}” and “${name}”`
    : edge === 'in'
      ? `Into “${name}”`
      : `Out of “${name}”`
  const kinds = pluginRegistry.catalog('transition').map((d) => ({ value: d.id, label: d.name }))
  const max = maxTransitionDuration(clip)
  const easing = easingChoice(transition.easing)
  return (
    <>
      <Header
        icon={<Blend />}
        title={pluginRegistry.get(transition.kind)?.name ?? 'Transition'}
        meta={meta}
      />
      <Section title="Transition">
        <FieldRow label="Type" trailing={<span className={styles.trailSpacer} />}>
          <Select
            value={transition.kind}
            onChange={(kind) => changeTransitionKind(clipId, edge, kind)}
            options={kinds}
            ariaLabel="Transition type"
          />
        </FieldRow>
        <FieldRow label="Duration" trailing={<span className={styles.trailSpacer} />}>
          <Slider
            value={Math.min(transition.duration, max)}
            min={0.1}
            max={max}
            step={0.05}
            onChange={(v) => setTransitionDuration(clipId, edge, v)}
            onCommit={() => editor.endGesture()}
            ariaLabel="Transition duration"
            valueText={seconds(transition.duration)}
          />
          <span className={`${styles.value} ${styles.valueUnit} tnum`}>{seconds(transition.duration)}</span>
        </FieldRow>
        <FieldRow label="Easing" trailing={<span className={styles.trailSpacer} />}>
          <Select
            value={easing}
            onChange={(v) => v !== 'custom' && setTransitionEasing(clipId, edge, v)}
            options={easing === 'custom' ? [...EASINGS, { value: 'custom', label: 'Custom' }] : EASINGS}
            ariaLabel="Transition easing"
          />
        </FieldRow>
        <div className={styles.padded}>
          <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={() => removeTransition(clipId, edge)}>
            Remove transition
          </Button>
        </div>
      </Section>
    </>
  )
}
