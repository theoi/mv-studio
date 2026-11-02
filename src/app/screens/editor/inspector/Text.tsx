import { useRef, type ReactNode } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Type } from 'lucide-react'
import { titleCardCommands } from '../../../../director/titleCard.ts'
import type { ParamSpec } from '../../../../engine/types.ts'
import type { Clip, Id, ParamValue, TextClip, TextStyle } from '../../../../model/index.ts'
import {
  ColorField,
  FieldRow,
  NumberField,
  Section,
  Segmented,
  Select,
  Slider,
  Switch,
  TextArea,
} from '../../../ds/Fields.tsx'
import { formatSpan } from '../../../format.ts'
import { dispatch, editor, useProject } from '../../../state/project.ts'
import {
  fontChoice,
  NO_PRESET,
  presetOptions,
  presetParams,
  setDecoration,
  setFont,
  setPreset,
  setPresetParam,
  setStyleValue,
  setWeight,
  TEXT_DECORATIONS,
  weightChoice,
  type TextDecoration,
} from '../../../state/textStyle.ts'
import { Header, TransformSection } from './parts.tsx'
import styles from '../Inspector.module.css'

const spacer = <span className={styles.trailSpacer} />

export function FontRow({ clip }: { clip: TextClip }) {
  const { assets } = useProject()
  const { value, options } = fontChoice(clip.style, assets)
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
            { label: 'Change text size', coalesceKey: `inspector:${clip.id}:size` },
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
          {
            label: `Change ${ariaLabel.toLowerCase()}`,
            coalesceKey: `inspector:${clip.id}:${path.join('.')}`,
          },
        )
      }
      onCommit={() => editor.endGesture()}
    />
  )
}

export function WeightRow({ clip }: { clip: TextClip }) {
  const { value, options } = weightChoice(clip.style)
  return (
    <FieldRow label="Weight" trailing={spacer}>
      <Select
        value={value}
        onChange={(w) => setWeight(clip, Number(w))}
        ariaLabel="Font weight"
        options={options}
      />
    </FieldRow>
  )
}

export function ColorRow({ clip }: { clip: TextClip }) {
  return (
    <FieldRow label="Color" trailing={spacer}>
      <TextColor clip={clip} path={['style', 'color']} value={clip.style.color} ariaLabel="Text color" />
    </FieldRow>
  )
}

function AlignRow({ clip }: { clip: TextClip }) {
  return (
    <FieldRow label="Align" trailing={spacer}>
      <Segmented<TextStyle['align']>
        value={clip.style.align}
        onChange={(align) => setStyleValue(clip, ['align'], align, { label: `Align ${align}` })}
        ariaLabel="Text alignment"
        size="sm"
        block
        options={[
          { value: 'left', label: <AlignLeft />, title: 'Left' },
          { value: 'center', label: <AlignCenter />, title: 'Center' },
          { value: 'right', label: <AlignRight />, title: 'Right' },
        ]}
      />
    </FieldRow>
  )
}

/** A number in a text style (at `path` under `style`) on a slider, one undo step per drag. */
function StyleSlider({
  clip,
  path,
  label,
  value,
  min,
  max,
  step,
  format,
}: {
  clip: TextClip
  path: string[]
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
}) {
  return (
    <FieldRow label={label} trailing={spacer}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => setStyleValue(clip, path, v, { gesture: true })}
        onCommit={() => editor.endGesture()}
        ariaLabel={label}
      />
      <span className={`${styles.value} tnum`}>{format(value)}</span>
    </FieldRow>
  )
}

const px = (v: number) => `${Math.round(v)} px`

function SpacingRows({ clip }: { clip: TextClip }) {
  return (
    <>
      <StyleSlider
        clip={clip}
        path={['letterSpacing']}
        label="Spacing"
        value={clip.style.letterSpacing}
        min={-0.1}
        max={0.5}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <StyleSlider
        clip={clip}
        path={['lineHeight']}
        label="Line height"
        value={clip.style.lineHeight}
        min={0.8}
        max={2}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
      />
    </>
  )
}

/** One collapsed section for an outline, shadow or background: on or off, then its values. */
function DecorationSection({ clip, part }: { clip: TextClip; part: TextDecoration }) {
  const { name } = TEXT_DECORATIONS[part]
  const on = !!clip.style[part]
  const slider = (key: string, label: string, value: number, min: number, max: number) => (
    <StyleSlider
      clip={clip}
      path={[part, key]}
      label={label}
      value={value}
      min={min}
      max={max}
      step={1}
      format={px}
    />
  )
  const { stroke, shadow, background } = clip.style
  return (
    <Section
      title={name}
      defaultOpen={false}
      actions={
        <Switch checked={on} onCheckedChange={(v) => setDecoration(clip, part, v)} ariaLabel={`${name} on`} />
      }
    >
      {on ? (
        <FieldRow label="Color" trailing={spacer}>
          <TextColor
            clip={clip}
            path={['style', part, 'color']}
            value={clip.style[part]?.color ?? '#000000'}
            ariaLabel={`${name} color`}
          />
        </FieldRow>
      ) : (
        <p className={styles.note}>Off. Use the switch to turn it on.</p>
      )}
      {part === 'stroke' && stroke && slider('width', 'Width', stroke.width, 0, 20)}
      {part === 'shadow' && shadow && (
        <>
          {slider('blur', 'Blur', shadow.blur, 0, 60)}
          {slider('offsetX', 'Offset X', shadow.offsetX, -40, 40)}
          {slider('offsetY', 'Offset Y', shadow.offsetY, -40, 40)}
        </>
      )}
      {part === 'background' && background && (
        <>
          {slider('padding', 'Padding', background.padding, 0, 60)}
          {slider('radius', 'Corners', background.radius, 0, 40)}
        </>
      )}
    </Section>
  )
}

/** Outline, shadow and background, each in a collapsed section. */
export function DecorationSections({ clip }: { clip: TextClip }) {
  return (
    <>
      <DecorationSection clip={clip} part="stroke" />
      <DecorationSection clip={clip} part="shadow" />
      <DecorationSection clip={clip} part="background" />
    </>
  )
}

export function PresetRow({ clip }: { clip: TextClip }) {
  return (
    <FieldRow label="Preset" trailing={spacer}>
      <Select
        value={clip.animation?.presetId ?? NO_PRESET}
        onChange={(id) => setPreset(clip, id)}
        ariaLabel="Kinetic preset"
        options={presetOptions()}
      />
    </FieldRow>
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

/** The settings of the clip's kinetic preset, from the preset itself, or `empty` without a preset. */
export function PresetSettings({
  clip,
  empty = <p className={styles.note}>No kinetic preset. Pick one under Style.</p>,
}: {
  clip: TextClip
  empty?: ReactNode
}) {
  const params = presetParams(clip)
  if (!params.length) return empty
  return (
    <>
      {params.map(({ spec, value }) => (
        <PresetParam key={spec.key} clip={clip} spec={spec} value={value} />
      ))}
    </>
  )
}

export function TextInspector({ clip }: { clip: Extract<Clip, { type: 'text' }> }) {
  const typedIn = useRef<{ id: Id; before: string } | undefined>(undefined)
  // Leaving the field lays out a retyped director title card again, in the same undo step as the typing.
  const leaveText = () => {
    const typed = typedIn.current
    typedIn.current = undefined
    const relaid = typed ? titleCardCommands(editor.getProject(), typed.id, typed.before) : []
    if (typed && relaid.length)
      dispatch(relaid, { label: 'Edit text', coalesceKey: `inspector:${typed.id}:text` })
    editor.endGesture()
  }
  return (
    <>
      <Header
        icon={<Type />}
        title={clip.name ?? 'Text'}
        meta={`Text · ${formatSpan(clip.start, clip.duration)}`}
      />
      <Section title="Text">
        <div className={styles.padded}>
          <TextArea
            value={clip.text}
            onChange={(e) => {
              if (typedIn.current?.id !== clip.id) typedIn.current = { id: clip.id, before: clip.text }
              dispatch(
                { type: 'clip.set', clipId: clip.id, path: ['text'], value: e.target.value },
                { label: 'Edit text', coalesceKey: `inspector:${clip.id}:text` },
              )
            }}
            onBlur={leaveText}
            rows={2}
            aria-label="Text content"
          />
        </div>
        <FontRow clip={clip} />
        <WeightRow clip={clip} />
        <SizeRow clip={clip} />
        <ColorRow clip={clip} />
        <AlignRow clip={clip} />
        <SpacingRows clip={clip} />
      </Section>
      <DecorationSections clip={clip} />
      <Section title="Animation" defaultOpen={false}>
        <PresetRow clip={clip} />
        <PresetSettings clip={clip} empty={null} />
      </Section>
      <TransformSection clip={clip} />
    </>
  )
}
