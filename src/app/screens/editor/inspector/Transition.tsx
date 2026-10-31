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
  transitionName,
  transitionOf,
  transitionSeconds,
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

/** Inspector › Transition: the transition at a cut, or into or out of a clip. */
export function TransitionInspector({ clipId, edge }: { clipId: string; edge: TransitionEdge }) {
  const project = useProject()
  const clip = project.clips[clipId]
  const transition = transitionOf(clip, edge)
  if (!clip || !transition) return null
  const spot = transitionSpots(project, clip.trackId).find((s) => s.clipId === clipId && s.edge === edge)
  const from = spot?.fromId ? project.clips[spot.fromId] : undefined
  const name = viewOf(project, clip).name
  // The two clips on lines of their own: on one line, the narrow inspector cut off the clip it belongs to.
  const meta = from
    ? `From “${viewOf(project, from).name}”`
    : edge === 'in'
      ? `Into “${name}”`
      : `Out of “${name}”`
  const metaBelow = from ? `Into “${name}”` : undefined
  const kinds = pluginRegistry.catalog('transition').map((d) => ({ value: d.id, label: d.name }))
  const max = maxTransitionDuration(clip)
  const easing = easingChoice(transition.easing)
  return (
    <>
      <Header icon={<Blend />} title={transitionName(transition)} meta={meta} metaBelow={metaBelow} />
      <Section title="Transition">
        <FieldRow label="Type">
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
            valueText={transitionSeconds(transition.duration)}
          />
          <span className={`${styles.value} ${styles.valueUnit} tnum`}>
            {transitionSeconds(transition.duration)}
          </span>
        </FieldRow>
        <FieldRow label="Easing">
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
