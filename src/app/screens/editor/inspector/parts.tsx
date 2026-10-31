import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import type { BlendMode, Clip, PropertyPath, VisualClip } from '../../../../model/index.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { AnimateButtons, FieldRow, NumberField, Section, Select, Slider } from '../../../ds/Fields.tsx'
import { dispatch, useProject } from '../../../state/project.ts'
import { useAnimatable } from './animatable.ts'
import { blendModes } from './blendModes.ts'
import styles from '../Inspector.module.css'

/** Top of every inspector: a thumbnail or icon, the selection's name and a one-line summary. */
export function Header({
  icon,
  thumb,
  title,
  meta,
}: {
  icon?: ReactNode
  thumb?: string
  title: string
  meta: string
}) {
  return (
    <div className={styles.header}>
      {thumb ? (
        <span className={styles.thumb} style={{ backgroundImage: `url(${thumb})` }} />
      ) : (
        <span className={styles.icon}>{icon}</span>
      )}
      <div className={styles.headerText}>
        <div className={styles.title}>{title}</div>
        <div className={`${styles.meta} tnum`}>{meta}</div>
      </div>
    </div>
  )
}

function NumberProp({
  clip,
  path,
  label,
  unit,
  toView,
  fromView,
  step = 1,
  prefix,
}: {
  clip: Clip
  path: PropertyPath
  label: string
  unit?: string
  toView: (v: number) => number
  fromView: (v: number) => number
  step?: number
  prefix?: string
}) {
  const a = useAnimatable(clip, path, undefined, { label })
  return (
    <NumberField
      value={toView(Number(a.value ?? 0))}
      onChange={(v) => a.set(fromView(v))}
      onCommit={a.commit}
      unit={unit}
      step={step}
      prefix={prefix}
      ariaLabel={label}
    />
  )
}

export function TransformSection({ clip }: { clip: VisualClip }) {
  const project = useProject()
  const { width, height } = project.settings
  const x = useAnimatable(clip, ['transform', 'x'])
  const scale = useAnimatable(clip, ['transform', 'scaleX'])
  const rot = useAnimatable(clip, ['transform', 'rotation'])
  const reset = () =>
    dispatch(
      [
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'x', 'value'], value: 0.5 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'y', 'value'], value: 0.5 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleX', 'value'], value: 1 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleY', 'value'], value: 1 },
        { type: 'clip.set', clipId: clip.id, path: ['transform', 'rotation', 'value'], value: 0 },
      ],
      { label: 'Reset transform' },
    )
  return (
    <Section
      title="Transform"
      actions={
        <IconButton label="Reset transform" size="xs" tooltipSide="left" onClick={reset}>
          <RotateCcw />
        </IconButton>
      }
    >
      <FieldRow label="Position" trailing={<AnimateButtons property="Position" {...x.buttons} />}>
        <NumberProp
          clip={clip}
          path={['transform', 'x']}
          label="Position X"
          prefix="X"
          toView={(v) => Math.round((v - 0.5) * width)}
          fromView={(v) => v / width + 0.5}
        />
        <NumberProp
          clip={clip}
          path={['transform', 'y']}
          label="Position Y"
          prefix="Y"
          toView={(v) => Math.round((v - 0.5) * height)}
          fromView={(v) => v / height + 0.5}
        />
      </FieldRow>
      <FieldRow label="Scale" trailing={<AnimateButtons property="Scale" {...scale.buttons} />}>
        <NumberField
          value={Math.round(Number(scale.value ?? 1) * 100)}
          onChange={(v) =>
            dispatch(
              [
                { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleX', 'value'], value: v / 100 },
                { type: 'clip.set', clipId: clip.id, path: ['transform', 'scaleY', 'value'], value: v / 100 },
              ],
              { coalesceKey: `inspector:${clip.id}:scale`, label: 'Change scale' },
            )
          }
          onCommit={scale.commit}
          unit="%"
          min={1}
          ariaLabel="Scale"
        />
      </FieldRow>
      <FieldRow label="Rotation" trailing={<AnimateButtons property="Rotation" {...rot.buttons} />}>
        <NumberProp
          clip={clip}
          path={['transform', 'rotation']}
          label="Rotation"
          unit="°"
          toView={(v) => v}
          fromView={(v) => v}
        />
      </FieldRow>
    </Section>
  )
}

export function CompositingSection({ clip }: { clip: VisualClip }) {
  const opacity = useAnimatable(clip, ['opacity'], undefined, { label: 'Opacity' })
  const pct = Math.round(Number(opacity.value ?? 1) * 100)
  return (
    <Section title="Compositing">
      <FieldRow label="Opacity" trailing={<AnimateButtons property="Opacity" {...opacity.buttons} />}>
        <Slider
          value={pct}
          onChange={(v) => opacity.set(v / 100)}
          onCommit={opacity.commit}
          ariaLabel="Opacity"
        />
        <span className={`${styles.value} tnum`}>{pct}%</span>
      </FieldRow>
      <FieldRow label="Blend" trailing={<span className={styles.trailSpacer} />}>
        <Select<BlendMode>
          value={clip.blendMode}
          onChange={(v) =>
            dispatch(
              { type: 'clip.set', clipId: clip.id, path: ['blendMode'], value: v },
              { label: 'Change blend mode' },
            )
          }
          options={blendModes}
          ariaLabel="Blend mode"
        />
      </FieldRow>
    </Section>
  )
}
