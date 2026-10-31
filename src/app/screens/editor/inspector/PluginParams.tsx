import { useState } from 'react'
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
import { BUILT_IN_LUTS, isLutAsset } from '../../../../plugins/lut.ts'
import { LUT_FILE_TYPES, loadLut, lutFiles, pickFile } from '../../../state/luts.ts'
import { editor, useProject } from '../../../state/project.ts'
import { settingName, useAnimatable, valueAtCommands } from './animatable.ts'
import { LutFilesDialog } from './LutFiles.tsx'
import styles from '../Inspector.module.css'

const spacer = <span className={styles.trailSpacer} />

type NumberSpec = Extract<ParamSpec, { type: 'number' }>

const stepOf = (spec: NumberSpec) => spec.step ?? (spec.max - spec.min) / 100

/** Stands for no image: a select option can't have an empty value. */
const NONE = 'none'
/** The LUT choice's actions: ask for a LUT file, and open the project's LUT files. */
const LOAD_LUT = 'load-lut'
const MANAGE_LUTS = 'manage-luts'

/** A built-in file's name as a choice: "bundled:luts/neutral.png" reads "Neutral". */
function builtInName(value: string): string {
  const file = value
    .replace(/^bundled:/, '')
    .replace(/^.*\//, '')
    .replace(/\.[^.]+$/, '')
  return file.charAt(0).toUpperCase() + file.slice(1).replace(/[-_]/g, ' ')
}

type Option = { value: string; label: string; description?: string; disabled?: boolean }

/**
 * The choices for an image setting: none and the project's images, with the value when it is none of them. A LUT
 * lists LUT files only, since a photo there breaks the colors: the built-in ones, the imported ones, then Load a LUT
 * file… and, once there are imported ones, Manage LUT files….
 */
function imageOptions(project: Project, value: string, role: 'lut' | 'texture' | undefined): Option[] {
  const options: Option[] = [{ value: NONE, label: 'None' }]
  if (role === 'lut') {
    const luts = lutFiles(project)
    const builtIn =
      BUILT_IN_LUTS.includes(value) || !value.startsWith('bundled:')
        ? BUILT_IN_LUTS
        : [...BUILT_IN_LUTS, value]
    options.push(
      ...builtIn.map((v) => ({ value: v, label: builtInName(v), description: 'Built in' })),
      ...luts.map((asset) => ({ value: asset.id, label: asset.name })),
    )
    if (!options.some((o) => o.value === value)) options.push({ value, label: 'Missing LUT' })
    options.push({ value: LOAD_LUT, label: 'Load a LUT file…', description: '.cube file or Hald CLUT image' })
    if (luts.length) options.push({ value: MANAGE_LUTS, label: 'Manage LUT files…' })
    return options
  }
  const images = Object.values(project.assets).filter((asset) => asset.kind === 'image' && !isLutAsset(asset))
  options.push(...images.map((asset) => ({ value: asset.id, label: asset.name })))
  if (!options.some((o) => o.value === value))
    options.push(
      value.startsWith('bundled:')
        ? { value, label: builtInName(value), description: 'Built in' }
        : { value, label: project.assets[value]?.name ?? 'Missing image' },
    )
  if (!images.length)
    options.push({
      value: 'no-images',
      label: 'No images yet',
      description: 'Import one in Media',
      disabled: true,
    })
  return options
}

/** An image setting's choice; for a LUT, also loading a LUT file into it and managing the project's LUT files. */
function ImageRow({
  clip,
  path,
  spec,
  name,
  value,
  choose,
}: {
  clip: Clip
  path: PropertyPath
  spec: Extract<ParamSpec, { type: 'image' }>
  name: string
  value: string
  choose: (value: string) => void
}) {
  const project = useProject()
  const [managing, setManaging] = useState(false)
  const focusChoice = () =>
    document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${CSS.escape(name)}"]`)?.focus()
  const load = async () => {
    const file = await pickFile(LUT_FILE_TYPES)
    if (!file) return focusChoice()
    await loadLut(file, (assetId) => {
      const now = editor.getProject().clips[clip.id]
      return now && assetId !== value ? valueAtCommands(now, path, assetId, 0) : []
    })
  }
  return (
    // A file name needs the row's width, so the choice takes the buttons' space too.
    <FieldRow label={spec.label}>
      <Select
        value={value}
        onChange={(v) =>
          v === LOAD_LUT ? void load() : v === MANAGE_LUTS ? setManaging(true) : choose(v === NONE ? '' : v)
        }
        ariaLabel={name}
        options={imageOptions(project, value, spec.role)}
      />
      {spec.role === 'lut' && <LutFilesDialog open={managing} onOpenChange={setManaging} />}
    </FieldRow>
  )
}
/**
 * One plugin parameter (of a generator or an effect) as an inspector row, for the Animatable at `path`. With an
 * `owner` (an effect's name), its controls and undo steps name it too ("RGB split amount"), so settings of several
 * effects on one clip are told apart.
 */
export function ParamRow({
  clip,
  path,
  spec,
  owner,
}: {
  clip: Clip
  path: PropertyPath
  spec: ParamSpec
  owner?: string
}) {
  const a = useAnimatable(clip, path, spec.default, { label: spec.label, owner })
  const name = owner ? settingName(spec.label, owner) : spec.label
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
              ariaLabel={name}
            />
          </FieldRow>
        )
      const shown = formatParam(spec, n)
      return (
        <FieldRow
          label={spec.label}
          trailing={spec.animatable === false ? spacer : <AnimateButtons property={name} {...a.buttons} />}
        >
          <Slider
            value={n}
            min={spec.min}
            max={spec.max}
            step={stepOf(spec)}
            onChange={a.set}
            onCommit={a.commit}
            ariaLabel={name}
            valueText={shown}
          />
          <span className={`${styles.value} ${spec.unit ? styles.valueUnit : ''} tnum`}>{shown}</span>
        </FieldRow>
      )
    }
    case 'color':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <ColorField value={String(a.value)} onChange={a.set} onCommit={a.commit} ariaLabel={name} />
        </FieldRow>
      )
    case 'select':
      return (
        // A dropdown takes the buttons' space too, so names like "Teal and orange" fit the narrow inspector.
        <FieldRow label={spec.label} trailing={spec.options.length <= 3 ? spacer : undefined}>
          {spec.options.length <= 3 ? (
            <Segmented
              value={String(a.value)}
              onChange={once}
              ariaLabel={name}
              size="sm"
              block
              options={spec.options}
            />
          ) : (
            <Select value={String(a.value)} onChange={once} ariaLabel={name} options={spec.options} />
          )}
        </FieldRow>
      )
    case 'boolean':
      return (
        <FieldRow label={spec.label} trailing={spacer}>
          <Switch checked={!!a.value} onCheckedChange={once} ariaLabel={name} />
        </FieldRow>
      )
    case 'image':
      return (
        <ImageRow
          clip={clip}
          path={path}
          spec={spec}
          name={name}
          value={String(a.value ?? '') || NONE}
          choose={once}
        />
      )
    default:
      return null
  }
}

/** Rows for a plugin's parameters stored under `base` (a generator's `params`, or an effect's). */
export function PluginParams({
  clip,
  base,
  specs,
  owner,
}: {
  clip: Clip
  base: PropertyPath
  specs: ParamSpec[]
  owner?: string
}) {
  return (
    <>
      {specs.map((spec) => (
        <ParamRow key={spec.key} clip={clip} path={[...base, spec.key]} spec={spec} owner={owner} />
      ))}
    </>
  )
}
