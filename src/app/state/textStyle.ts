/**
 * Text and lyric style edits from the inspector: font and weight, style values, outline, shadow and background,
 * kinetic preset and its settings, line position, and copying a lyric line's look to every line. Each is one undo
 * step.
 */
import { pluginRegistry } from '../../engine/registry.ts'
import type { ParamSpec } from '../../engine/types.ts'
import type { Asset, EditCommand, ParamValue, Project, TextClip, TextStyle } from '../../model/index.ts'
import { BUNDLED_FONTS, bundledFont, fontStack, type FontCategory } from '../../plugins/typography/fonts.ts'
import { plural } from '../format.ts'
import { dispatch, editor } from './project.ts'
import { toast } from './ui.ts'

const CATEGORY: Record<FontCategory, string> = {
  sans: 'Sans serif',
  serif: 'Serif',
  display: 'Display',
  handwriting: 'Handwriting',
  pixel: 'Pixel',
}

/** The first family of a font-family stack, without quotes. */
function firstFamily(fontFamily: string): string {
  return (
    fontFamily
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? fontFamily
  )
}

/** The picker value of an imported font: its asset id, which can't clash with a family name. */
const IMPORTED = 'font:'

/** An imported font goes by its file name without the extension. */
const importedName = (asset: Asset) => asset.name.replace(/\.[^.]+$/, '')

interface FontOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
  group?: string
}

/** A bundled font only when no imported font is set: an imported file may share a bundled family's name. */
function bundledOf(style: TextStyle) {
  return style.fontAssetId ? undefined : bundledFont(style.fontFamily)
}

/**
 * The font picker for a text style: the project's imported fonts and every bundled font, in two groups once there
 * are imported fonts, plus the style's own font first when it is neither (a system font), so the picker always shows
 * what the text uses. An imported font the project no longer has stays listed, disabled, by the name the style kept.
 */
export function fontChoice(
  style: TextStyle,
  assets: Project['assets'],
): { value: string; options: FontOption[] } {
  const imported: FontOption[] = Object.values(assets)
    .filter((a) => a.kind === 'font')
    .map((a) => ({ value: IMPORTED + a.id, label: importedName(a), group: 'Imported' }))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (style.fontAssetId && !assets[style.fontAssetId])
    imported.push({
      value: IMPORTED + style.fontAssetId,
      label: firstFamily(style.fontFamily),
      description: 'Missing: shown in a fallback font',
      disabled: true,
      group: 'Imported',
    })
  const options = [
    ...imported,
    ...BUNDLED_FONTS.map((f) => ({
      value: f.family,
      label: f.family,
      description: [CATEGORY[f.category], ...f.tags.slice(0, 2)].join(' · '),
      ...(imported.length ? { group: 'Bundled' } : {}),
    })),
  ]
  if (style.fontAssetId) return { value: IMPORTED + style.fontAssetId, options }
  const bundled = bundledFont(style.fontFamily)
  if (bundled) return { value: bundled.family, options }
  const own = firstFamily(style.fontFamily)
  return { value: own, options: [{ value: own, label: own, description: 'Not bundled' }, ...options] }
}

/**
 * Sets an imported font, regular and upright: a font file is usually one face, and the browser would fake a heavier
 * weight or a slant. Its name goes first in the family stack, ahead of the font the text had, so a project that loses
 * the file still names it and draws in the previous font.
 */
function setImportedFont(clip: TextClip, assetId: string): void {
  const asset = editor.getProject().assets[assetId]
  if (asset?.kind !== 'font' || clip.style.fontAssetId === assetId) return
  const name = importedName(asset)
  const previous = clip.style.fontAssetId
    ? clip.style.fontFamily.split(',').slice(1).join(',').trim()
    : clip.style.fontFamily
  dispatch(
    {
      type: 'clip.set',
      clipId: clip.id,
      path: ['style'],
      value: {
        ...clip.style,
        fontAssetId: assetId,
        // Quotes and commas would break the family list when the name is read back or dropped.
        fontFamily: `"${name.replace(/["\\,]/g, '')}", ${previous || 'Inter, system-ui, sans-serif'}`,
        fontWeight: 400,
        italic: false,
      },
    },
    { label: `Font: ${name}` },
  )
}

/** Sets a bundled font, keeping the weight and italics where the font has them, or an imported one. */
export function setFont(clip: TextClip, family: string): void {
  if (family.startsWith(IMPORTED)) return setImportedFont(clip, family.slice(IMPORTED.length))
  const font = BUNDLED_FONTS.find((f) => f.family === family)
  if (!font || bundledOf(clip.style) === font) return
  const [lightest, boldest] = font.weights
  const { fontAssetId: _imported, ...style } = clip.style
  dispatch(
    {
      type: 'clip.set',
      clipId: clip.id,
      path: ['style'],
      value: {
        ...style,
        fontFamily: fontStack(family),
        fontWeight: Math.min(boldest, Math.max(lightest, clip.style.fontWeight)),
        italic: clip.style.italic && font.italic,
      },
    },
    { label: `Font: ${family}` },
  )
}

export const NO_PRESET = 'none'

/** Kinetic presets for a picker, after "None". */
export function presetOptions(): { value: string; label: string; description?: string }[] {
  return [
    { value: NO_PRESET, label: 'None', description: 'The line appears as a whole' },
    ...pluginRegistry
      .catalog('text-animation')
      .map((p) => ({ value: p.id, label: p.name, ...(p.description ? { description: p.description } : {}) })),
  ]
}

/** Exit settings every preset shares, kept when switching presets. */
const SHARED_PARAMS = ['exit', 'exitDuration']

/** Gives a text clip a kinetic preset (or none) with its default settings, keeping its exit. */
export function setPreset(clip: TextClip, presetId: string): void {
  if ((clip.animation?.presetId ?? NO_PRESET) === presetId) return
  if (presetId === NO_PRESET) {
    dispatch(
      { type: 'clip.set', clipId: clip.id, path: ['animation'], value: undefined },
      { label: 'No text animation' },
    )
    return
  }
  const def = pluginRegistry.get(presetId)
  if (def?.kind !== 'text-animation') return
  const params: Record<string, ParamValue> = {}
  for (const key of SHARED_PARAMS) {
    const kept = clip.animation?.params[key]
    if (kept !== undefined && def.params.some((s) => s.key === key)) params[key] = kept
  }
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['animation'], value: { presetId, params } },
    { label: `Text animation: ${def.name}` },
  )
}

/** The settings of a text clip's kinetic preset that the inspector shows (advanced ones stay hidden). */
export function presetParams(clip: TextClip): { spec: ParamSpec; value: ParamValue }[] {
  const def = clip.animation ? pluginRegistry.get(clip.animation.presetId) : undefined
  if (!clip.animation || def?.kind !== 'text-animation') return []
  const params = clip.animation.params
  return def.params
    .filter((s) => !s.advanced)
    .map((spec) => ({ spec, value: params[spec.key] ?? spec.default }))
}

/** Changes one setting of the clip's kinetic preset. Pass `gesture` while a slider is dragged. */
export function setPresetParam(clip: TextClip, spec: ParamSpec, value: ParamValue, gesture?: boolean): void {
  if (!clip.animation) return
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['animation', 'params', spec.key], value },
    gesture ? { coalesceKey: `inspector:${clip.id}:animation.${spec.key}` } : { label: spec.label },
  )
}

export type LinePosition = 'top' | 'center' | 'lower'

const POSITION_Y: Record<LinePosition, number> = { top: 0.22, center: 0.5, lower: 0.75 }
const POSITION_NAME: Record<LinePosition, string> = { top: 'Top', center: 'Center', lower: 'Lower' }

/** Where a text clip sits vertically, to the nearest of top, center and lower. */
export function linePosition(clip: TextClip): LinePosition {
  const y = clip.transform.y.value
  return y < 0.36 ? 'top' : y > 0.64 ? 'lower' : 'center'
}

export function setLinePosition(clip: TextClip, position: LinePosition): void {
  if (linePosition(clip) === position) return
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['transform', 'y', 'value'], value: POSITION_Y[position] },
    { label: `Position: ${POSITION_NAME[position]}` },
  )
}

/**
 * Gives every other lyric line the look of `clip`: its style, kinetic preset, karaoke highlight and height on screen.
 * Words, timing and the rest of each line's transform are kept. Lines on locked tracks are skipped.
 */
export function styleAllLinesCommands(clip: TextClip): EditCommand[] {
  const project = editor.getProject()
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const commands: EditCommand[] = []
  for (const line of Object.values(project.clips)) {
    if (line.type !== 'text' || !line.lyricLineId || line.id === clip.id || locked.has(line.trackId)) continue
    const set = (path: (string | number)[], value: unknown) =>
      commands.push({ type: 'clip.set', clipId: line.id, path, value: structuredClone(value) })
    set(['style'], clip.style)
    set(['animation'], clip.animation)
    set(['karaoke'], clip.karaoke)
    set(['transform', 'y', 'value'], clip.transform.y.value)
  }
  return commands
}

export function applyStyleToAllLines(clip: TextClip): void {
  const commands = styleAllLinesCommands(clip)
  const others = new Set(commands.map((c) => ('clipId' in c ? c.clipId : ''))).size
  if (!others) {
    toast('There are no other lyric lines to style')
    return
  }
  const label = 'Apply style to all lines'
  if (dispatch(commands, { label }))
    toast(`Style applied to all ${plural(others + 1, 'lyric line')}`, {
      label: 'Undo',
      run: () => {
        if (editor.undoLabel() === label) editor.undo()
      },
    })
}

const WEIGHTS: [number, string][] = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
]

const weightName = (weight: number) => WEIGHTS.find(([w]) => w === weight)?.[1]

/**
 * The weights the style's font has, and the style's own: all of them for a system font, and only Regular for an
 * imported one, whose file is loaded as a single regular face (other weights would be faked by the browser).
 */
export function weightChoice(style: TextStyle): {
  value: string
  options: { value: string; label: string; description?: string }[]
} {
  const [lightest, boldest] = style.fontAssetId ? [400, 400] : (bundledOf(style)?.weights ?? [100, 900])
  const weights = WEIGHTS.map(([w]) => w).filter((w) => w >= lightest && w <= boldest)
  if (!weights.includes(style.fontWeight)) weights.push(style.fontWeight)
  return {
    value: String(style.fontWeight),
    options: weights
      .sort((a, b) => a - b)
      .map((w) => {
        const name = weightName(w)
        return name
          ? { value: String(w), label: name }
          : { value: String(w), label: String(w), description: 'Custom' }
      }),
  }
}

export function setWeight(clip: TextClip, weight: number): void {
  if (clip.style.fontWeight === weight) return
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['style', 'fontWeight'], value: weight },
    { label: `Weight: ${weightName(weight) ?? weight}` },
  )
}

/** Outline, shadow and background: optional parts of a text style, with the values they start from. */
export const TEXT_DECORATIONS = {
  stroke: { name: 'Outline', initial: { color: '#000000', width: 4 } },
  shadow: { name: 'Shadow', initial: { color: '#00000099', blur: 16, offsetX: 0, offsetY: 4 } },
  background: { name: 'Background', initial: { color: '#000000a6', padding: 16, radius: 12 } },
} as const

export type TextDecoration = keyof typeof TEXT_DECORATIONS

/** Turns an outline, shadow or background on (from its starting values) or off, as one undo step. */
export function setDecoration(clip: TextClip, part: TextDecoration, on: boolean): void {
  if (!!clip.style[part] === on) return
  const { name, initial } = TEXT_DECORATIONS[part]
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['style', part], value: on ? { ...initial } : undefined },
    { label: `${name} ${on ? 'on' : 'off'}` },
  )
}

/** Changes one value of a text style; `gesture` coalesces a slider drag into one undo step. */
export function setStyleValue(
  clip: TextClip,
  path: string[],
  value: string | number,
  options: { gesture: true } | { label: string },
): void {
  dispatch(
    { type: 'clip.set', clipId: clip.id, path: ['style', ...path], value },
    'label' in options
      ? { label: options.label }
      : { coalesceKey: `inspector:${clip.id}:style.${path.join('.')}` },
  )
}
