/**
 * Text styles: one-click typography for text and lyric clips (font, weight, size, case, color, outline, shadow,
 * caption box), optionally with a kinetic preset and karaoke. Applying a style is one undoable edit that keeps the
 * clip's text, position, alignment and wrap width.
 */
import type { EditCommand } from '../../model/commands.ts'
import type { ProjectEditor } from '../../model/editor.ts'
import type { Id, ParamValue, Project, TextClip, TextStyle } from '../../model/types.ts'
import { fontStack } from './fonts.ts'

export interface TextStylePreset {
  id: string
  name: string
  description: string
  /** Search words and moods, e.g. ['bold', 'hip-hop']. */
  tags: string[]
  /** Short text for the picker tile. */
  sample: string
  style: Partial<Omit<TextStyle, 'align' | 'maxWidth' | 'fontAssetId'>>
  animation?: { presetId: string; params?: Record<string, ParamValue> }
  karaoke?: NonNullable<TextClip['karaoke']>
}

const base = {
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.15,
  textTransform: 'none',
  stroke: undefined,
  shadow: undefined,
  background: undefined,
} as const satisfies Partial<TextStyle>

export const TEXT_STYLES: TextStylePreset[] = [
  {
    id: 'title',
    name: 'Title',
    description: 'Huge condensed capitals with a soft drop shadow.',
    tags: ['title', 'bold', 'impact', 'poster', 'hip-hop'],
    sample: 'NEON',
    style: {
      ...base,
      fontFamily: fontStack('Anton'),
      fontWeight: 400,
      fontSize: 150,
      textTransform: 'uppercase',
      letterSpacing: 0.02,
      lineHeight: 1.0,
      color: '#ffffff',
      shadow: { color: '#00000099', blur: 24, offsetX: 0, offsetY: 6 },
    },
    animation: { presetId: 'stamp' },
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    description: 'Clean geometric sans with open tracking.',
    tags: ['subtitle', 'clean', 'modern', 'artist', 'credit'],
    sample: 'Lumen Drive',
    style: {
      ...base,
      fontFamily: fontStack('Montserrat'),
      fontWeight: 500,
      fontSize: 60,
      letterSpacing: 0.06,
      color: '#ffffff',
      shadow: { color: '#00000080', blur: 12, offsetX: 0, offsetY: 2 },
    },
    animation: { presetId: 'rise' },
  },
  {
    id: 'caption',
    name: 'Caption',
    description: 'Readable lyrics on a rounded dark box, like subtitles.',
    tags: ['caption', 'lyrics', 'readable', 'subtitles', 'accessible'],
    sample: 'Under the neon skyline',
    style: {
      ...base,
      fontFamily: fontStack('Inter'),
      fontWeight: 600,
      fontSize: 52,
      lineHeight: 1.3,
      color: '#ffffff',
      background: { color: '#000000a6', padding: 16, radius: 12 },
    },
    animation: { presetId: 'fade-up', params: { distance: 0.25 } },
  },
  {
    id: 'outline',
    name: 'Outline',
    description: 'Hollow heavy letters that fill with color as they are sung.',
    tags: ['outline', 'karaoke', 'bold', 'graphic'],
    sample: 'ALIVE',
    style: {
      ...base,
      fontFamily: fontStack('Archivo Black'),
      fontWeight: 400,
      fontSize: 120,
      textTransform: 'uppercase',
      letterSpacing: 0.03,
      color: '#ffffff00',
      stroke: { color: '#ffffff', width: 2.5 },
    },
    karaoke: { highlightColor: '#ffffff', mode: 'word' },
    animation: { presetId: 'sweep', params: { dim: 1 } },
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description: 'Bold outlined lyrics that light up word by word as they are sung.',
    tags: ['karaoke', 'lyrics', 'sing-along', 'bold'],
    sample: 'Sing it loud',
    style: {
      ...base,
      fontFamily: fontStack('Montserrat'),
      fontWeight: 800,
      fontSize: 84,
      color: '#ffffff',
      stroke: { color: '#000000', width: 5 },
    },
    karaoke: { highlightColor: '#facc15', mode: 'word' },
    animation: { presetId: 'sweep' },
  },
  {
    id: 'neon',
    name: 'Neon sign',
    description: 'Glowing tube lettering that flickers on.',
    tags: ['neon', 'glow', 'night', 'retro', 'electronic', 'club'],
    sample: 'OPEN LATE',
    style: {
      ...base,
      fontFamily: fontStack('Montserrat'),
      fontWeight: 600,
      fontSize: 100,
      textTransform: 'uppercase',
      letterSpacing: 0.08,
      color: '#fdf4ff',
      stroke: { color: '#ff3df2', width: 1.5 },
      shadow: { color: '#ff3df2', blur: 30, offsetX: 0, offsetY: 0 },
    },
    animation: { presetId: 'flicker' },
  },
  {
    id: 'poster',
    name: 'Poster',
    description: 'Tall all-caps headline type, cinematic and tight.',
    tags: ['poster', 'cinematic', 'condensed', 'movie', 'epic'],
    sample: 'MIDNIGHT',
    style: {
      ...base,
      fontFamily: fontStack('Bebas Neue'),
      fontWeight: 400,
      fontSize: 170,
      textTransform: 'uppercase',
      letterSpacing: 0.06,
      lineHeight: 0.95,
      color: '#ffffff',
    },
    animation: { presetId: 'blur-in' },
  },
  {
    id: 'headline',
    name: 'Headline',
    description: 'Strong condensed sans for statements.',
    tags: ['headline', 'condensed', 'strong', 'rock'],
    sample: 'NO SLEEP',
    style: {
      ...base,
      fontFamily: fontStack('Oswald'),
      fontWeight: 650,
      fontSize: 120,
      textTransform: 'uppercase',
      letterSpacing: 0.01,
      lineHeight: 1.05,
      color: '#ffffff',
      shadow: { color: '#00000099', blur: 16, offsetX: 0, offsetY: 4 },
    },
    animation: { presetId: 'slide-in' },
  },
  {
    id: 'elegant',
    name: 'Elegant',
    description: 'Italic high-contrast serif for ballads and love songs.',
    tags: ['elegant', 'romantic', 'serif', 'ballad', 'classic', 'love'],
    sample: 'Forever yours',
    style: {
      ...base,
      fontFamily: fontStack('Playfair Display'),
      fontWeight: 500,
      italic: true,
      fontSize: 100,
      color: '#fffaf0',
      shadow: { color: '#00000066', blur: 18, offsetX: 0, offsetY: 3 },
    },
    animation: { presetId: 'blur-in' },
  },
  {
    id: 'soul',
    name: 'Soul',
    description: 'Warm vintage display serif.',
    tags: ['vintage', 'soul', 'jazz', 'serif', 'retro', 'warm'],
    sample: 'Velvet nights',
    style: {
      ...base,
      fontFamily: fontStack('DM Serif Display'),
      fontWeight: 400,
      fontSize: 110,
      color: '#fde68a',
      shadow: { color: '#7c2d12aa', blur: 0, offsetX: 4, offsetY: 4 },
    },
    animation: { presetId: 'rise' },
  },
  {
    id: 'marker',
    name: 'Marker',
    description: 'Raw hand-drawn marker lettering.',
    tags: ['marker', 'street', 'punk', 'raw', 'handwritten', 'grunge'],
    sample: 'Rebel heart',
    style: {
      ...base,
      fontFamily: fontStack('Permanent Marker'),
      fontWeight: 400,
      fontSize: 110,
      color: '#ffffff',
      shadow: { color: '#00000099', blur: 10, offsetX: 3, offsetY: 3 },
    },
    animation: { presetId: 'swing' },
  },
  {
    id: 'handwritten',
    name: 'Handwritten',
    description: 'Relaxed handwriting for acoustic and indie songs.',
    tags: ['handwritten', 'acoustic', 'indie', 'personal', 'soft'],
    sample: 'little things',
    style: { ...base, fontFamily: fontStack('Caveat'), fontWeight: 600, fontSize: 120, color: '#ffffff' },
    animation: { presetId: 'typewriter', params: { cursor: false, speed: 14 } },
  },
  {
    id: 'script',
    name: 'Retro script',
    description: 'Looping 50s script, sunny and nostalgic.',
    tags: ['script', 'retro', 'summer', 'surf', 'pop', 'fun'],
    sample: 'Summer love',
    style: {
      ...base,
      fontFamily: fontStack('Pacifico'),
      fontWeight: 400,
      fontSize: 110,
      color: '#fff1f2',
      shadow: { color: '#f43f5e', blur: 0, offsetX: 4, offsetY: 4 },
    },
    animation: { presetId: 'drop' },
  },
  {
    id: 'pixel',
    name: 'Pixel',
    description: 'Arcade bitmap type with a hard offset shadow.',
    tags: ['pixel', '8-bit', 'game', 'chiptune', 'retro'],
    sample: 'PLAYER 1',
    style: {
      ...base,
      fontFamily: fontStack('Press Start 2P'),
      fontWeight: 400,
      fontSize: 60,
      lineHeight: 1.5,
      textTransform: 'uppercase',
      color: '#ffffff',
      shadow: { color: '#7c3aed', blur: 0, offsetX: 5, offsetY: 5 },
    },
    animation: { presetId: 'typewriter', params: { speed: 24 } },
  },
  {
    id: 'comic',
    name: 'Comic',
    description: 'Heavy yellow letters with a black outline and pop shadow.',
    tags: ['comic', 'fun', 'pop', 'loud', 'cartoon'],
    sample: 'BOOM!',
    style: {
      ...base,
      fontFamily: fontStack('Archivo Black'),
      fontWeight: 400,
      fontSize: 120,
      textTransform: 'uppercase',
      color: '#facc15',
      stroke: { color: '#000000', width: 6 },
      shadow: { color: '#000000', blur: 0, offsetX: 7, offsetY: 7 },
    },
    animation: { presetId: 'bounce' },
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Light lowercase grotesk with wide spacing.',
    tags: ['minimal', 'clean', 'electronic', 'ambient', 'calm'],
    sample: 'slow motion',
    style: {
      ...base,
      fontFamily: fontStack('Space Grotesk'),
      fontWeight: 400,
      fontSize: 64,
      textTransform: 'lowercase',
      letterSpacing: 0.18,
      color: '#ffffff',
    },
    animation: { presetId: 'fade-up' },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Wide expressive display caps, art-school energy.',
    tags: ['editorial', 'art', 'fashion', 'wide', 'experimental'],
    sample: 'AVANT',
    style: {
      ...base,
      fontFamily: fontStack('Syne'),
      fontWeight: 800,
      fontSize: 110,
      textTransform: 'uppercase',
      letterSpacing: 0.02,
      color: '#ffffff',
    },
    animation: { presetId: 'glitch-text', params: { intensity: 0.35 } },
  },
]

export function textStyle(id: string): TextStylePreset | undefined {
  return TEXT_STYLES.find((s) => s.id === id)
}

/**
 * Commands that apply a text style to text clips: style fields are replaced (text, position, alignment and wrap width
 * are kept), and the style's kinetic preset and karaoke are set when it has them. Clips on locked tracks are skipped.
 */
export function textStyleCommands(
  project: Project,
  clipIds: readonly Id[],
  styleId: string,
  options: { animation?: boolean; karaoke?: boolean } = {},
): EditCommand[] {
  const preset = textStyle(styleId)
  if (!preset) throw new Error(`Unknown text style "${styleId}"`)
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const commands: EditCommand[] = []
  for (const id of clipIds) {
    const clip = project.clips[id]
    if (clip?.type !== 'text' || locked.has(clip.trackId)) continue
    const style: Record<string, unknown> = { ...clip.style, ...preset.style }
    for (const key of Object.keys(style)) if (style[key] === undefined) delete style[key]
    commands.push({ type: 'clip.set', clipId: id, path: ['style'], value: style })
    if (preset.animation && options.animation !== false)
      commands.push({
        type: 'clip.set',
        clipId: id,
        path: ['animation'],
        value: { presetId: preset.animation.presetId, params: { ...preset.animation.params } },
      })
    if (preset.karaoke && options.karaoke !== false)
      commands.push({ type: 'clip.set', clipId: id, path: ['karaoke'], value: { ...preset.karaoke } })
  }
  return commands
}

/** Applies a text style to clips as one undo step labeled with its name. */
export function applyTextStyle(editor: ProjectEditor, clipIds: readonly Id[], styleId: string): void {
  const commands = textStyleCommands(editor.getProject(), clipIds, styleId)
  if (commands.length)
    editor.dispatch(commands, { label: `Text style: ${textStyle(styleId)?.name ?? styleId}` })
}
