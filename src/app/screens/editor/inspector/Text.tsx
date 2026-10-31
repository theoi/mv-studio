import { Type } from 'lucide-react'
import type { ParamSpec } from '../../../../engine/types.ts'
import type { Clip, ParamValue, TextClip } from '../../../../model/index.ts'
import {
  ColorField,
  FieldRow,
  NumberField,
  Section,
  Select,
  Slider,
  Switch,
  TextArea,
} from '../../../ds/Fields.tsx'
import { formatTime } from '../../../format.ts'
import { dispatch, editor } from '../../../state/project.ts'
import { fontChoice, presetParams, setFont, setPresetParam } from '../../../state/textStyle.ts'
import { Header, TransformSection } from './parts.tsx'
import styles from '../Inspector.module.css'

const spacer = <span className={styles.trailSpacer} />

export function FontRow({ clip }: { clip: TextClip }) {
  const { value, options } = fontChoice(clip.style)
  return (
    <FieldRow label="Font" trailing={spacer}>
      <Select value={value} onChange={(family) => setFont(clip, family)} ariaLabel="Font" options={options} />
    </FieldRow>
  )
}

export function SizeRow({ clip }: { clip: TextClip }) {
  return (
    <FieldRow label="Size" trailing={spacer}>
      <NumberField
        value={clip.style.fontSize}
        onChange={(v) =>
          dispatch(
            { type: 'clip.set', clipId: clip.id, path: ['style', 'fontSize'], value: v },
            { coalesceKey: `inspector:${clip.id}:size` },
          )
        }
        onCommit={() => editor.endGesture()}
        unit="px"
        min={8}
        ariaLabel="Font size"
      />
    </FieldRow>
  )
}

/** A text color field (a TextStyle color, the karaoke highlight, ...) whose edits coalesce while the picker is open. */
export function TextColor({
  clip,
  path,
  value,
  ariaLabel,
}: {
  clip: TextClip
  path: string[]
  value: string
  ariaLabel: string
}) {
  return (
    <ColorField
      value={value}
      ariaLabel={ariaLabel}
      onChange={(hex) =>
        dispatch(
          { type: 'clip.set', clipId: clip.id, path, value: hex },
          { coalesceKey: `inspector:${clip.id}:${path.join('.')}` },
        )
      }
      onCommit={() => editor.endGesture()}
    />
  )
}

function decimals(spec: Extract<ParamSpec, { type: 'number' }>): number {
  const step = spec.step ?? (spec.max - spec.min) / 100
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2
}

function PresetParam({ clip, spec, value }: { clip: TextClip; spec: ParamSpec; value: ParamValue }) {
  switch (spec.type) {
    case 'number': {
      const n = Number(value)
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Slider
            value={n}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? (spec.max - spec.min) / 100}
            onChange={(v) => setPresetParam(clip, spec, v, true)}
            onCommit={() => editor.endGesture()}
            ariaLabel={spec.label}
          />
          <span className={`${styles.value} tnum`}>
            {n.toFixed(decimals(spec))}
            {spec.unit ? ` ${spec.unit}` : ''}
          </span>
        </FieldRow>
      )
    }
    case 'select':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Select
            value={String(value)}
            onChange={(v) => setPresetParam(clip, spec, v)}
            ariaLabel={spec.label}
            options={spec.options}
          />
        </FieldRow>
      )
    case 'boolean':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Switch
            checked={!!value}
            onCheckedChange={(v) => setPresetParam(clip, spec, v)}
            ariaLabel={spec.label}
          />
        </FieldRow>
      )
    case 'color':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <TextColor
            clip={clip}
            path={['animation', 'params', spec.key]}
            value={String(value)}
            ariaLabel={spec.label}
          />
        </FieldRow>
      )
    default:
      return null
  }
}

/** The settings of the clip's kinetic preset, from the preset itself. */
export function PresetSettings({ clip }: { clip: TextClip }) {
  const params = presetParams(clip)
  if (!params.length) return <p className={styles.note}>No kinetic preset. Pick one under Style.</p>
  return (
    <>
      {params.map(({ spec, value }) => (
        <PresetParam key={spec.key} clip={clip} spec={spec} value={value} />
      ))}
    </>
  )
}

export function TextInspector({ clip }: { clip: Extract<Clip, { type: 'text' }> }) {
  return (
    <>
      <Header
        icon={<Type />}
        title={clip.name ?? 'Text'}
        meta={`Text · ${formatTime(clip.start, true)} – ${formatTime(clip.start + clip.duration, true)}`}
      />
      <Section title="Text">
        <div className={styles.padded}>
          <TextArea
            value={clip.text}
            onChange={(e) =>
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['text'], value: e.target.value },
                { coalesceKey: `inspector:${clip.id}:text` },
              )
            }
            onBlur={() => editor.endGesture()}
            rows={2}
            aria-label="Text content"
          />
        </div>
        <FontRow clip={clip} />
        <SizeRow clip={clip} />
      </Section>
      <TransformSection clip={clip} />
    </>
  )
}
