/**
 * Fonts bundled with the app for text clips, all free for commercial use (OFL-1.1, Permanent Marker Apache-2.0; see
 * THIRD_PARTY_NOTICES.md). Each family is registered as lazy FontFaces (latin and latin-ext subsets), so a font file
 * downloads only when a clip uses it, and the text renderer's fonts.load() waits for it in preview and export alike.
 * Other scripts fall back to system fonts.
 */
import anton from '@fontsource/anton/files/anton-latin-400-normal.woff2?url'
import antonExt from '@fontsource/anton/files/anton-latin-ext-400-normal.woff2?url'
import archivoBlack from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2?url'
import archivoBlackExt from '@fontsource/archivo-black/files/archivo-black-latin-ext-400-normal.woff2?url'
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url'
import bebasExt from '@fontsource/bebas-neue/files/bebas-neue-latin-ext-400-normal.woff2?url'
import dmSerif from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff2?url'
import dmSerifExt from '@fontsource/dm-serif-display/files/dm-serif-display-latin-ext-400-normal.woff2?url'
import dmSerifItalic from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-italic.woff2?url'
import dmSerifItalicExt from '@fontsource/dm-serif-display/files/dm-serif-display-latin-ext-400-italic.woff2?url'
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff2?url'
import pacificoExt from '@fontsource/pacifico/files/pacifico-latin-ext-400-normal.woff2?url'
import marker from '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff2?url'
import pressStart from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2?url'
import pressStartExt from '@fontsource/press-start-2p/files/press-start-2p-latin-ext-400-normal.woff2?url'
import caveat from '@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2?url'
import caveatExt from '@fontsource-variable/caveat/files/caveat-latin-ext-wght-normal.woff2?url'
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url'
import interItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url'
import interItalicExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2?url'
import montserrat from '@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2?url'
import montserratExt from '@fontsource-variable/montserrat/files/montserrat-latin-ext-wght-normal.woff2?url'
import montserratItalic from '@fontsource-variable/montserrat/files/montserrat-latin-wght-italic.woff2?url'
import montserratItalicExt from '@fontsource-variable/montserrat/files/montserrat-latin-ext-wght-italic.woff2?url'
import oswald from '@fontsource-variable/oswald/files/oswald-latin-wght-normal.woff2?url'
import oswaldExt from '@fontsource-variable/oswald/files/oswald-latin-ext-wght-normal.woff2?url'
import playfair from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2?url'
import playfairExt from '@fontsource-variable/playfair-display/files/playfair-display-latin-ext-wght-normal.woff2?url'
import playfairItalic from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-italic.woff2?url'
import playfairItalicExt from '@fontsource-variable/playfair-display/files/playfair-display-latin-ext-wght-italic.woff2?url'
import spaceGrotesk from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?url'
import spaceGroteskExt from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-ext-wght-normal.woff2?url'
import syne from '@fontsource-variable/syne/files/syne-latin-wght-normal.woff2?url'
import syneExt from '@fontsource-variable/syne/files/syne-latin-ext-wght-normal.woff2?url'

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

export type FontCategory = 'sans' | 'serif' | 'display' | 'handwriting' | 'pixel'

export interface BundledFont {
  /** CSS family name to put first in TextStyle.fontFamily. */
  family: string
  category: FontCategory
  /** Weight range of a variable font, or [w, w] for a single weight. */
  weights: [number, number]
  italic: boolean
  license: 'OFL-1.1' | 'Apache-2.0'
  /** Short words for font pickers and the director, e.g. ['condensed', 'poster']. */
  tags: string[]
  files: { url: string; range: string; style: 'normal' | 'italic' }[]
}

const latin = (url: string, ext?: string, style: 'normal' | 'italic' = 'normal') => [
  { url, range: LATIN, style },
  ...(ext ? [{ url: ext, range: LATIN_EXT, style }] : []),
]

export const BUNDLED_FONTS: BundledFont[] = [
  {
    family: 'Inter',
    category: 'sans',
    weights: [100, 900],
    italic: true,
    license: 'OFL-1.1',
    tags: ['clean', 'neutral', 'caption', 'subtitle'],
    files: [...latin(inter, interExt), ...latin(interItalic, interItalicExt, 'italic')],
  },
  {
    family: 'Montserrat',
    category: 'sans',
    weights: [100, 900],
    italic: true,
    license: 'OFL-1.1',
    tags: ['geometric', 'modern', 'bold', 'pop'],
    files: [...latin(montserrat, montserratExt), ...latin(montserratItalic, montserratItalicExt, 'italic')],
  },
  {
    family: 'Space Grotesk',
    category: 'sans',
    weights: [300, 700],
    italic: false,
    license: 'OFL-1.1',
    tags: ['tech', 'minimal', 'quirky', 'electronic'],
    files: latin(spaceGrotesk, spaceGroteskExt),
  },
  {
    family: 'Syne',
    category: 'display',
    weights: [400, 800],
    italic: false,
    license: 'OFL-1.1',
    tags: ['editorial', 'art', 'wide', 'experimental'],
    files: latin(syne, syneExt),
  },
  {
    family: 'Oswald',
    category: 'display',
    weights: [200, 700],
    italic: false,
    license: 'OFL-1.1',
    tags: ['condensed', 'headline', 'strong'],
    files: latin(oswald, oswaldExt),
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    weights: [400, 400],
    italic: false,
    license: 'OFL-1.1',
    tags: ['condensed', 'poster', 'caps', 'cinematic'],
    files: latin(bebas, bebasExt),
  },
  {
    family: 'Anton',
    category: 'display',
    weights: [400, 400],
    italic: false,
    license: 'OFL-1.1',
    tags: ['impact', 'heavy', 'title', 'hip-hop'],
    files: latin(anton, antonExt),
  },
  {
    family: 'Archivo Black',
    category: 'display',
    weights: [400, 400],
    italic: false,
    license: 'OFL-1.1',
    tags: ['heavy', 'outline', 'comic', 'punchy'],
    files: latin(archivoBlack, archivoBlackExt),
  },
  {
    family: 'Playfair Display',
    category: 'serif',
    weights: [400, 900],
    italic: true,
    license: 'OFL-1.1',
    tags: ['elegant', 'classic', 'romantic', 'editorial'],
    files: [...latin(playfair, playfairExt), ...latin(playfairItalic, playfairItalicExt, 'italic')],
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    weights: [400, 400],
    italic: true,
    license: 'OFL-1.1',
    tags: ['vintage', 'soul', 'jazz', 'classic'],
    files: [...latin(dmSerif, dmSerifExt), ...latin(dmSerifItalic, dmSerifItalicExt, 'italic')],
  },
  {
    family: 'Permanent Marker',
    category: 'handwriting',
    weights: [400, 400],
    italic: false,
    license: 'Apache-2.0',
    tags: ['marker', 'street', 'punk', 'raw'],
    files: latin(marker),
  },
  {
    family: 'Caveat',
    category: 'handwriting',
    weights: [400, 700],
    italic: false,
    license: 'OFL-1.1',
    tags: ['handwritten', 'personal', 'acoustic', 'indie'],
    files: latin(caveat, caveatExt),
  },
  {
    family: 'Pacifico',
    category: 'handwriting',
    weights: [400, 400],
    italic: false,
    license: 'OFL-1.1',
    tags: ['script', 'retro', 'summer', 'surf'],
    files: latin(pacifico, pacificoExt),
  },
  {
    family: 'Press Start 2P',
    category: 'pixel',
    weights: [400, 400],
    italic: false,
    license: 'OFL-1.1',
    tags: ['pixel', '8-bit', 'game', 'chiptune'],
    files: latin(pressStart, pressStartExt),
  },
]

const FALLBACK: Record<FontCategory, string> = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  display: 'Impact, sans-serif',
  handwriting: 'cursive',
  pixel: 'monospace',
}

/** The bundled font a font-family stack starts with, if any. */
export function bundledFont(fontFamily: string): BundledFont | undefined {
  const first = fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  return BUNDLED_FONTS.find((f) => f.family === first)
}

/** A font-family stack for a bundled family with a fallback of the same kind, e.g. "Anton, Impact, sans-serif". */
export function fontStack(family: string): string {
  const font = BUNDLED_FONTS.find((f) => f.family === family)
  if (!font) return family
  const name = /\s/.test(family) ? `"${family}"` : family
  return `${name}, ${FALLBACK[font.category]}`
}

const registered = new WeakSet<FontFaceSet>()

/** Adds every bundled face to a font set (document.fonts by default). Faces download on first use. */
export function registerBundledFonts(set?: FontFaceSet): boolean {
  const target =
    set ??
    (typeof document !== 'undefined'
      ? document.fonts
      : (globalThis as unknown as { fonts?: FontFaceSet }).fonts)
  if (!target || typeof FontFace === 'undefined' || registered.has(target)) return false
  registered.add(target)
  for (const font of BUNDLED_FONTS) {
    const weight = font.weights[0] === font.weights[1] ? `${font.weights[0]}` : font.weights.join(' ')
    for (const file of font.files)
      target.add(
        new FontFace(font.family, `url(${file.url}) format("woff2")`, {
          weight,
          style: file.style,
          unicodeRange: file.range,
          display: 'block',
        }),
      )
  }
  return true
}
