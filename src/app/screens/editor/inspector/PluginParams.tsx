import type { ParamSpec } from '../../../../engine/types.ts'
import type { Clip, Project, PropertyPath } from '../../../../model/index.ts'
import {
  AnimateButtons,
  ColorField,
  FieldRow,
  NumberField,
  Segmented,
  Select,
  Slider,
  Switch,
} from '../../../ds/Fields.tsx'
import { formatParam } from '../../../format.ts'
import { useProject } from '../../../state/project.ts'
import { useAnimatable } from './animatable.ts'
import styles from '../Inspector.module.css'

const spacer = <span className={styles.trailSpacer} />

type NumberSpec = Extract<ParamSpec, { type: 'number' }>

const stepOf = (spec: NumberSpec) => spec.step ?? (spec.max - spec.min) / 100

/** Stands for no image: a select option can't have an empty value. */
const NONE = 'none'

/** The choices for an image setting: none, the project's images, and the value when it is a built-in file. */
function imageOptions(project: Project, value: string) {
  const images = Object.values(project.assets).filter((asset) => asset.kind === 'image')
  const options: { value: string; label: string; description?: string; disabled?: boolean }[] = [
    { value: NONE, label: 'None' },
    ...images.map((asset) => ({ value: asset.id, label: asset.name })),
  ]
  if (!options.some((o) => o.value === value))
    options.push({ value, label: value.replace(/^bundled:/, '').replace(/^.*\//, '') })
  if (!images.length)
    options.push({
      value: 'no-images',
      label: 'No images yet',
      description: 'Import one in Media',
      disabled: true,
    })
  return options
}

/** One plugin parameter (of a generator or an effect) as an inspector row, for the Animatable at `path`. */
export function ParamRow({ clip, path, spec }: { clip: Clip; path: PropertyPath; spec: ParamSpec }) {
  const project = useProject()
  const a = useAnimatable(clip, path, spec.default, { label: spec.label })
  const once = (value: string | boolean) => {
    a.set(value)
    a.commit()
  }
  switch (spec.type) {
    case 'number': {
      const n = Number(a.value)
      if (spec.animatable === false && stepOf(spec) >= 1)
        return (
          <FieldRow label={spec.label} trailing={spacer}>
            <NumberField
              value={n}
              onChange={a.set}
              onCommit={a.commit}
              min={spec.min}
              max={spec.max}
              step={stepOf(spec)}
              unit={spec.unit}
              ariaLabel={spec.label}
            />
          </FieldRow>
        )
      const shown = formatParam(spec, n)
      return (
        <FieldRow
          label={spec.label}
          trailing={
            spec.animatable === false ? spacer : <AnimateButtons property={spec.label} {...a.buttons} />
          }
        >
          <Slider
            value={n}
            min={spec.min}
            max={spec.max}
            step={stepOf(spec)}
            onChange={a.set}
            onCommit={a.commit}
            ariaLabel={spec.label}
            valueText={shown}
          />
          <span className={`${styles.value} ${spec.unit ? styles.valueUnit : ''} tnum`}>{shown}</span>
        </FieldRow>
      )
    }
    case 'color':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <ColorField value={String(a.value)} onChange={a.set} onCommit={a.commit} ariaLabel={spec.label} />
        </FieldRow>
      )
    case 'select':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          {spec.options.length <= 3 ? (
            <Segmented
              value={String(a.value)}
              onChange={once}
              ariaLabel={spec.label}
              size="sm"
              block
              options={spec.options}
            />
          ) : (
            <Select value={String(a.value)} onChange={once} ariaLabel={spec.label} options={spec.options} />
          )}
        </FieldRow>
      )
    case 'boolean':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Switch checked={!!a.value} onCheckedChange={once} ariaLabel={spec.label} />
        </FieldRow>
      )
    case 'image': {
      const value = String(a.value ?? '') || NONE
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Select
            value={value}
            onChange={(v) => once(v === NONE ? '' : v)}
            ariaLabel={spec.label}
            options={imageOptions(project, value)}
          />
        </FieldRow>
      )
    }
    default:
      return null
  }
}

/** Rows for a plugin's parameters stored under `base` (a generator's `params`, or an effect's). */
export function PluginParams({ clip, base, specs }: { clip: Clip; base: PropertyPath; specs: ParamSpec[] }) {
  return (
    <>
      {specs.map((spec) => (
        <ParamRow key={spec.key} clip={clip} path={[...base, spec.key]} spec={spec} />
      ))}
    </>
  )
}
