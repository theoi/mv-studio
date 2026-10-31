/**
 * Text and lyric style edits from the inspector: font, kinetic preset and its settings, line position, and copying a
 * lyric line's look to every line. Each is one undo step.
 */
import { pluginRegistry } from '../../engine/registry.ts'
import type { ParamSpec } from '../../engine/types.ts'
import type { EditCommand, ParamValue, TextClip, TextStyle } from '../../model/index.ts'
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

/**
 * The font picker for a text style: every bundled font, plus the style's own font first when it is not one of them
 * (a system font or an imported one), so the picker always shows what the text uses.
 */
export function fontChoice(style: TextStyle): {
  value: string
  options: { value: string; label: string; description: string }[]
} {
  const options = BUNDLED_FONTS.map((f) => ({
    value: f.family,
    label: f.family,
    description: [CATEGORY[f.category], ...f.tags.slice(0, 2)].join(' · '),
  }))
  const bundled = bundledFont(style.fontFamily)
  if (bundled) return { value: bundled.family, options }
  const own = firstFamily(style.fontFamily)
  return { value: own, options: [{ value: own, label: own, description: 'Not bundled' }, ...options] }
}

/** Sets a bundled font, keeping the weight and italics where the font has them. */
export function setFont(clip: TextClip, family: string): void {
  const font = BUNDLED_FONTS.find((f) => f.family === family)
  if (!font || bundledFont(clip.style.fontFamily) === font) return
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
