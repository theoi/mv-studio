import { Fragment, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import type { BlendMode, Clip, PropertyPath, VisualClip } from '../../../../model/index.ts'
import { IconButton } from '../../../ds/Button.tsx'
import { AnimateButtons, FieldRow, NumberField, Section, Select, Slider } from '../../../ds/Fields.tsx'
import { dispatch, resetTransform, useProject } from '../../../state/project.ts'
import { useAnimatable } from './animatable.ts'
import { blendModes } from './blendModes.ts'
import styles from '../Inspector.module.css'

/**
 * A summary line ("Background · 1:04.00 – 1:36.00 · 32.0 s") that wraps only between its " · " parts when it doesn't
 * fit, so a time or a length is never split or cut; only a part wider than the line alone is cut. The separator stays
 * at the end of its part, so the text is the summary as written.
 */
export function MetaLine({ text, className }: { text: string; className?: string }) {
  const parts = text.split(' · ')
  return (
    <div className={[styles.meta, styles.metaParts, 'tnum', className].filter(Boolean).join(' ')}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className={styles.metaPart}>{i < parts.length - 1 ? `${part} ·` : part}</span>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * Top of every inspector: a thumbnail or icon, the selection's name and a summary, on one line when it fits (see
 * MetaLine). A second line (`metaBelow`) is for a summary that would not fit the narrow inspector on one line.
 */
export function Header({
  icon,
  thumb,
  title,
  meta,
  metaBelow,
}: {
  icon?: ReactNode
  thumb?: string
  title: string
  meta: string
  metaBelow?: string
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
        <MetaLine text={meta} />
        {metaBelow && <MetaLine text={metaBelow} />}
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
  const position = useAnimatable(clip, ['transform', 'x'], undefined, { linked: [['transform', 'y']] })
  const scale = useAnimatable(clip, ['transform', 'scaleX'], undefined, {
    label: 'Scale',
    linked: [['transform', 'scaleY']],
  })
  const rot = useAnimatable(clip, ['transform', 'rotation'])
  const reset = () => resetTransform(clip.id)
  return (
    <Section
      title="Transform"
      actions={
        <IconButton label="Reset transform" size="xs" tooltipSide="left" onClick={reset}>
          <RotateCcw />
        </IconButton>
      }
    >
      <FieldRow label="Position" trailing={<AnimateButtons property="Position" {...position.buttons} />}>
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
          onChange={(v) => scale.set(v / 100)}
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
