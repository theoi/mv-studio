import type { ParamSpec } from '../../../../engine/types.ts'
import type { Clip, PropertyPath } from '../../../../model/index.ts'
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
import { useAnimatable } from './animatable.ts'
import styles from '../Inspector.module.css'

const spacer = <span className={styles.trailSpacer} />

type NumberSpec = Extract<ParamSpec, { type: 'number' }>

const stepOf = (spec: NumberSpec) => spec.step ?? (spec.max - spec.min) / 100

function formatNumber(spec: NumberSpec, n: number): string {
  const step = stepOf(spec)
  const text = n.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2)
  return spec.unit ? `${text} ${spec.unit}` : text
}

/** One plugin parameter (of a generator or an effect) as an inspector row, for the Animatable at `path`. */
export function ParamRow({ clip, path, spec }: { clip: Clip; path: PropertyPath; spec: ParamSpec }) {
  const a = useAnimatable(clip, path, spec.default)
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
          />
          <span className={`${styles.value} tnum`}>{formatNumber(spec, n)}</span>
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
