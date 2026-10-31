/**
 * Lyric typography: the text style (src/plugins/typography TEXT_STYLES) a look pairs with, sized to read at a glance,
 * broken into balanced rows, and the stressed word of a line picked for emphasis. The director has no font metrics,
 * so widths are estimated from average letter widths per bundled font; estimates err wide so rows fit.
 */
import type { AspectPreset } from '../model/types.ts'
import { bundledFont } from '../plugins/typography/fonts.ts'
import { TEXT_STYLES, type TextStylePreset } from '../plugins/typography/styles.ts'
import { bestByTags, findItem, type DirectorCatalog, type LookPreset } from './catalog.ts'
import type { TextStyleSpec } from './plan.ts'

/** The text style each built-in look pairs with for lyrics. Other looks match a style by their tags. */
export const LOOK_TEXT_STYLE: Record<string, string> = {
  clean: 'karaoke',
  neon: 'neon',
  warm: 'soul',
  vintage: 'elegant',
  moody: 'minimal',
  dreamy: 'elegant',
  mono: 'headline',
  vivid: 'comic',
  cinematic: 'poster',
  vhs: 'editorial',
  ice: 'subtitle',
  ember: 'title',
}

/** Styles that do not suit whole lyric lines: hollow letters and bitmap type are hard to read in motion. */
const NOT_FOR_LYRICS = new Set(['outline', 'pixel'])

/** Entrance of the emphasized word: a stronger beat in the same voice as the style's own animation. */
const EMPHASIS_ANIMATION: Record<string, string> = {
  karaoke: 'zoom-in',
  subtitle: 'zoom-in',
  caption: 'zoom-in',
  minimal: 'blur-in',
  elegant: 'blur-in',
  poster: 'blur-in',
  soul: 'rise',
  handwritten: 'rise',
  script: 'drop',
  marker: 'stamp',
  title: 'stamp',
  headline: 'stamp',
  comic: 'stamp',
  neon: 'flicker',
  editorial: 'glitch-text',
}

/**
 * Line size in px at a 1080-px-tall canvas: capitals about 7% of the frame height in landscape. Portrait frames are
 * narrow, so their lines are smaller relative to the height and wrap to more rows.
 */
const LINE_SIZE: Record<AspectPreset, number> = { '16:9': 100, '1:1': 88, '4:5': 84, '9:16': 70 }
const MAX_WIDTH: Record<AspectPreset, number> = { '16:9': 0.8, '1:1': 0.84, '4:5': 0.86, '9:16': 0.86 }
const MAX_ROWS: Record<AspectPreset, number> = { '16:9': 2, '1:1': 2, '4:5': 3, '9:16': 3 }
const ASPECT_RATIO: Record<AspectPreset, number> = { '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16 }
export const EMPHASIS_SCALE = 1.6

/** Average advance of a lowercase and an uppercase letter, in em. */
const FONT_WIDTH: Record<string, [number, number]> = {
  Inter: [0.55, 0.7],
  Montserrat: [0.62, 0.78],
  Anton: [0.44, 0.5],
  'Bebas Neue': [0.42, 0.42],
  Oswald: [0.46, 0.54],
  'Archivo Black': [0.64, 0.8],
  Syne: [0.62, 0.82],
  'Playfair Display': [0.5, 0.68],
  'DM Serif Display': [0.52, 0.68],
  'Space Grotesk': [0.56, 0.68],
  Caveat: [0.42, 0.52],
  Pacifico: [0.58, 0.74],
  'Permanent Marker': [0.62, 0.74],
  'Press Start 2P': [1, 1],
}
const DEFAULT_WIDTH: [number, number] = [0.6, 0.74]
/** Faces whose letters look small (or large) for their size, so lines of every style read alike. */
const FONT_SCALE: Record<string, number> = {
  Anton: 1.1,
  'Bebas Neue': 1.25,
  Oswald: 1.1,
  Caveat: 1.3,
  'Playfair Display': 1.05,
  'DM Serif Display': 1.05,
  'Press Start 2P': 0.7,
}

export interface LyricTypography {
  preset: TextStylePreset
  /** Style of lyric lines, at `lineSize`. */
  style: TextStyleSpec
  lineSize: number
  lineAnimation?: string
  emphasisAnimation?: string
  karaoke: boolean
  accent: string
  aspect: AspectPreset
}

export interface TypographyBrief {
  fontFamily?: string
  color?: string
  accentColor?: string
  uppercase?: boolean
  presetId?: string
  karaoke?: boolean
}

/** The text style a look pairs with: its own for built-in looks, else the best match for its tags. */
export function lyricTextStyle(look: LookPreset | undefined): TextStylePreset {
  const mapped = look ? TEXT_STYLES.find((s) => s.id === LOOK_TEXT_STYLE[look.id]) : undefined
  if (mapped) return mapped
  const candidates = TEXT_STYLES.filter((s) => !NOT_FOR_LYRICS.has(s.id))
  return (
    (look ? bestByTags(candidates, look.tags) : undefined) ??
    (TEXT_STYLES.find((s) => s.id === 'karaoke') as TextStylePreset)
  )
}

function luma(hex: string): number {
  const v = /^#([0-9a-f]{6})/i.exec(hex)?.[1]
  if (!v) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A colored glow or outline takes the look's accent (keeping its alpha); dark shadows and outlines stay. */
function tint(color: string, accent: string): string {
  if (luma(color) < 0.3) return color
  const alpha = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(color)?.[1] ?? ''
  return `${accent.slice(0, 7)}${alpha}`
}

const familyOf = (fontFamily: string | undefined) =>
  (fontFamily ? bundledFont(fontFamily)?.family : undefined) ?? ''

/**
 * Typography for the lyrics of a draft. Built-in looks use the style they pair with; a custom look's own text style
 * and animation apply over its matched style; brief choices (an LLM's) apply over both. Over busy backgrounds every
 * line gets a dark outline, and a soft dark halo unless the style has its own glow, so words stay readable over white
 * skies and walls.
 */
export function lyricTypography(o: {
  look?: LookPreset
  aspect: AspectPreset
  busy: boolean
  brief?: TypographyBrief
  catalog: DirectorCatalog
}): LyricTypography {
  const { look, brief } = o
  const preset = lyricTextStyle(look)
  const own = look && !LOOK_TEXT_STYLE[look.id] ? look.text : undefined
  const s = { ...preset.style, ...own?.style }
  const accent = brief?.accentColor ?? look?.accentColor ?? preset.karaoke?.highlightColor ?? '#facc15'
  const fontFamily = brief?.fontFamily ?? s.fontFamily ?? 'Inter, system-ui, sans-serif'
  const family = familyOf(fontFamily)
  const lineSize = Math.round(LINE_SIZE[o.aspect] * (FONT_SCALE[family] ?? 1))
  // Over footage the outline is always dark, so every look reads on bright frames; a colored outline (neon) gives
  // way to it and the style's glow stays in the shadow.
  const darkStroke = s.stroke && luma(s.stroke.color) < 0.3 ? s.stroke : undefined
  const stroke = o.busy
    ? darkStroke
      ? { ...darkStroke, width: Math.max(darkStroke.width, 3) }
      : { color: '#000000b3', width: Math.round(lineSize * 0.045) }
    : s.stroke
      ? { color: tint(s.stroke.color, accent), width: s.stroke.width }
      : undefined
  const hardShadow = s.shadow && s.shadow.blur === 0
  const shadow =
    s.shadow && !(o.busy && hardShadow && !s.stroke)
      ? { ...s.shadow, color: tint(s.shadow.color, accent) }
      : o.busy
        ? { color: '#000000b3', blur: Math.round(lineSize * 0.3), offsetX: 0, offsetY: 2 }
        : { color: '#00000080', blur: 14, offsetX: 0, offsetY: 3 }
  const uppercase = brief?.uppercase ?? s.textTransform === 'uppercase'
  const lowercase = brief?.uppercase === undefined && s.textTransform === 'lowercase'
  const style: TextStyleSpec = {
    fontFamily,
    fontSize: lineSize,
    fontWeight: s.fontWeight ?? 700,
    ...(s.italic ? { italic: true } : {}),
    ...(s.letterSpacing ? { letterSpacing: s.letterSpacing } : {}),
    lineHeight: s.lineHeight ?? 1.15,
    ...(lowercase ? { textTransform: 'lowercase' as const } : {}),
    color: brief?.color ?? look?.textColor ?? s.color ?? '#ffffff',
    align: 'center',
    maxWidth: MAX_WIDTH[o.aspect],
    uppercase,
    ...(stroke && stroke.width > 0 ? { stroke } : {}),
    shadow,
    ...(s.background ? { background: s.background } : {}),
  }
  const known = (id: string | undefined) => findItem(o.catalog.textPresets, id)?.id
  return {
    preset,
    style,
    lineSize,
    lineAnimation:
      known(brief?.presetId) ?? known(own?.animation?.presetId) ?? known(preset.animation?.presetId),
    emphasisAnimation: known(EMPHASIS_ANIMATION[preset.id]) ?? known('zoom-in'),
    karaoke: brief?.karaoke ?? !!preset.karaoke,
    accent,
    aspect: o.aspect,
  }
}

/** Sans styles not set in capitals take capitals in choruses, for contrast with the verses. */
const PEAK_CAPS = new Set(['karaoke', 'subtitle', 'caption', 'soul'])

/** `weight` when the font has it, else its heaviest weight below (faux bold looks smeared). */
function weightUpTo(style: TextStyleSpec, weight: number): number {
  const own = style.fontWeight ?? 700
  const max = bundledFont(style.fontFamily ?? '')?.weights[1]
  return max === undefined ? own : Math.max(own, Math.min(weight, max))
}

/** Lines in choruses: a little bigger, a step heavier, and in capitals where the style allows. */
export function peakStyle(type: LyricTypography, brief?: TypographyBrief): TextStyleSpec {
  const s = type.style
  return {
    ...s,
    fontSize: Math.round(type.lineSize * 1.08),
    fontWeight: weightUpTo(s, (s.fontWeight ?? 700) + 100),
    uppercase: brief?.uppercase ?? (!!s.uppercase || PEAK_CAPS.has(type.preset.id)),
  }
}

/** The emphasized word: much bigger, in the accent color and in capitals unless the style is script or lowercase. */
export function emphasisStyle(type: LyricTypography, line: TextStyleSpec, text: string): TextStyleSpec {
  const script = bundledFont(line.fontFamily ?? '')?.category === 'handwriting' || !!line.italic
  const style: TextStyleSpec = {
    ...line,
    fontSize: Math.round(type.lineSize * EMPHASIS_SCALE),
    fontWeight: weightUpTo(line, 900),
    color: type.accent,
    uppercase: line.textTransform !== 'lowercase' && (!!line.uppercase || !script),
  }
  const fit = rowWidth(style, type.aspect) / textWidth(text, style)
  if (fit < 1) style.fontSize = Math.max(type.lineSize, Math.floor((style.fontSize as number) * fit))
  return style
}

/** A title card line: bigger, heavier, widely tracked capitals (lowercase styles keep their case). */
export function titleStyle(
  type: LyricTypography,
  scale: number,
  weight: number,
  spacing: number,
): TextStyleSpec {
  const s = type.style
  return {
    ...s,
    fontSize: Math.round(type.lineSize * scale),
    fontWeight: weightUpTo(s, weight),
    letterSpacing: spacing,
    uppercase: s.textTransform !== 'lowercase',
  }
}

/** Frame width in px at a 1080-px-tall canvas. */
export function frameWidth(aspect: AspectPreset): number {
  return 1080 * ASPECT_RATIO[aspect]
}

/** Estimated width of a text in px at a 1080-px-tall canvas. */
export function textWidth(text: string, style: TextStyleSpec, fontSize = style.fontSize ?? 80): number {
  const [lower, upper] = FONT_WIDTH[familyOf(style.fontFamily)] ?? DEFAULT_WIDTH
  const spacing = style.letterSpacing ?? 0
  let em = 0
  for (const ch of text) {
    if (ch === ' ') em += 0.28
    else if (/[\p{Lu}]/u.test(ch) || (style.uppercase && /\p{L}/u.test(ch))) em += upper
    else if (/[\p{L}\p{N}]/u.test(ch)) em += lower
    else em += 0.3
    em += spacing
  }
  return em * fontSize
}

/** Usable row width in px at a 1080-px-tall canvas. */
export function rowWidth(style: TextStyleSpec, aspect: AspectPreset): number {
  return (style.maxWidth ?? MAX_WIDTH[aspect]) * frameWidth(aspect)
}

/** The split of `words` into `rows` rows with the narrowest widest row. */
function bestSplit(words: string[], rows: number, width: (s: string) => number) {
  let best: { rows: string[]; widest: number } | undefined
  const visit = (from: number, left: number, acc: string[]) => {
    if (left === 1) {
      const out = [...acc, words.slice(from).join(' ')]
      const widest = Math.max(...out.map(width))
      if (!best || widest < best.widest) best = { rows: out, widest }
      return
    }
    for (let i = from + 1; i <= words.length - (left - 1); i++)
      visit(i, left - 1, [...acc, words.slice(from, i).join(' ')])
  }
  if (words.length >= rows) visit(0, rows, [])
  return best
}

/**
 * A lyric line laid out in balanced rows (explicit line breaks, so wrapping never leaves one word alone on a row):
 * as few rows as fit, shrinking the type (to 70% at most) when even the most rows allowed do not.
 */
export function layoutLine(
  text: string,
  style: TextStyleSpec,
  aspect: AspectPreset,
  maxRows = MAX_ROWS[aspect],
): { text: string; fontSize: number; rows: number } {
  const words = text.split(/\s+/).filter(Boolean)
  const size = style.fontSize ?? LINE_SIZE[aspect]
  const limit = rowWidth(style, aspect)
  const width = (s: string) => textWidth(s, style, size)
  let last: { rows: string[]; widest: number } | undefined
  for (let rows = 1; rows <= Math.min(maxRows, words.length); rows++) {
    const split = bestSplit(words, rows, width)
    if (!split) break
    last = split
    if (split.widest <= limit) return { text: split.rows.join('\n'), fontSize: size, rows }
  }
  if (!last) return { text, fontSize: size, rows: 1 }
  const fontSize = Math.round(size * Math.max(0.7, limit / last.widest))
  return { text: last.rows.join('\n'), fontSize, rows: last.rows.length }
}

const STOPWORDS = new Set(
  (
    "a an the and or but so to of in on at for with from by as is am are was were be been being it its it's i i'm " +
    "im me my mine you you're your yours we our us they them their he him his she her this that these those there " +
    "here what who how when where why if then than oh ooh ah yeah hey la na do does did don't dont just like can " +
    "can't cant will won't wont would could should up down out all no not got get gonna wanna let let's into onto"
  ).split(' '),
)

export const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

/**
 * Where the emphasized tail of a sung line starts: its last content word (the stressed rhyme), counting trailing
 * small words with it, or undefined. Peaks emphasize any content word; other lines only a long word (7 letters) or a
 * hook (a word of the song title or one the chorus repeats), so verses keep most lines whole.
 */
export function emphasisStart(
  words: string[],
  o: { peak: boolean; hooks: ReadonlySet<string> },
): number | undefined {
  if (words.length < 3) return undefined
  for (let i = words.length - 1; i >= Math.max(1, words.length - 2); i--) {
    const w = normalizeWord(words[i] as string)
    const hook = o.hooks.has(w)
    if (STOPWORDS.has(w) || (w.replace(/'/g, '').length < 3 && !hook)) continue
    if (!o.peak && !hook && w.replace(/'/g, '').length < 7) return undefined
    const tail = words.slice(i).join(' ')
    return tail.length <= 16 ? i : undefined
  }
  return undefined
}

/** Content words of the title, and content words sung at least three times in choruses: the song's hooks. */
export function hookWords(title: string | undefined, chorusLines: string[]): Set<string> {
  const hooks = new Set<string>()
  const content = (text: string) =>
    text
      .split(/\s+/)
      .map(normalizeWord)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  for (const w of content(title ?? '')) hooks.add(w)
  const counts = new Map<string, number>()
  for (const line of chorusLines) for (const w of content(line)) counts.set(w, (counts.get(w) ?? 0) + 1)
  for (const [w, n] of counts) if (n >= 3) hooks.add(w)
  return hooks
}
