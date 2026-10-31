/**
 * Looks: one-click whole-video styles. A look sets a color grade and texture (an adjustment layer with adjustments
 * and effects), typography, the transition style and the visualizer palette in one undoable edit. Everything it
 * changes is ordinary project content the user can edit afterwards; nothing is hidden renderer state.
 *
 * Apply with applyLook(editor, id), or dispatch applyLookCommands(project, id) yourself as one step. The look layer is
 * an adjustment clip with `meta.role === 'look'` and `meta.lookId`; applying another look replaces it, as it does the
 * look layer of a director draft.
 */
import { directorMeta } from '../director/meta.ts'
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginDefinition, PluginRegistry } from '../engine/types.ts'
import type { EditCommand } from '../model/commands.ts'
import type { ProjectEditor } from '../model/editor.ts'
import { createSolidClip, createTrack } from '../model/factory.ts'
import { projectDuration } from '../model/queries.ts'
import type {
  AdjustmentClip,
  Clip,
  ColorAdjustmentKey,
  Id,
  ParamValue,
  Project,
  Seconds,
  TextStyle,
  Track,
} from '../model/types.ts'
import { createEffectInstance, createTransition } from './library.ts'
import { thumbnailUrl } from './thumbnails.ts'
import { fontStack } from './typography/fonts.ts'

export interface LookEffect {
  effectId: string
  /** Overrides of the effect's defaults. */
  params?: Record<string, ParamValue>
}

export interface LookDefinition {
  /** Stable id (kebab-case), stored in projects and plans. */
  id: string
  name: string
  description: string
  /** Search words and moods planners match, e.g. ['neon', 'night', 'club']. */
  tags: string[]
  /** Color adjustments of the look layer, each -1..1. */
  adjustments: Partial<Record<ColorAdjustmentKey, number>>
  /** Effects of the look layer, in order. */
  effects: LookEffect[]
  /** Text color that suits the look. */
  textColor: string
  /** Highlight color: karaoke fill, emphasis and accents. */
  accentColor: string
  /** Appended to AI generation prompts so generated shots share the look. */
  promptStyle: string
  /** Visualizer colors: generator params `color` (primary) and `color2` (secondary). */
  palette: { primary: string; secondary: string }
  /** Typography: style fields merged into every text clip, and the kinetic preset. */
  text?: { style?: Partial<TextStyle>; animation?: { presetId: string; params?: Record<string, ParamValue> } }
  /** Transition style for existing transitions; their durations and easing are kept. */
  transition?: { kind: string; params?: Record<string, ParamValue> }
  /** Library thumbnail URL (16:9 image). */
  thumbnail?: string
}

export interface LookRegistry {
  get(id: string): LookDefinition | undefined
  list(): LookDefinition[]
  /** Adds or replaces a look by id. */
  register(look: LookDefinition): void
  subscribe(listener: () => void): () => void
}

export function createLookRegistry(looks: readonly LookDefinition[] = BUILTIN_LOOKS): LookRegistry {
  const byId = new Map<string, LookDefinition>()
  const listeners = new Set<() => void>()
  const registry: LookRegistry = {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    register(look) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(look.id)) throw new Error(`Invalid look id "${look.id}"`)
      if (look.id === ORIGINAL_LOOK.id) throw new Error(`The look id "${look.id}" is reserved`)
      byId.set(look.id, look)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  for (const look of looks) registry.register(look)
  return registry
}

const LOOK_ROLE = 'look'
const LOOK_TRACK_NAME = 'Look'

/**
 * The "no look" choice pickers offer next to the looks (VJ mode's "Original" pad, the library's first tile). It is not
 * a registered look: choosing it removes the look layer with removeLookCommands.
 */
export const ORIGINAL_LOOK = {
  id: 'original',
  name: 'Original',
  description: 'The video’s own colors, without a look.',
  thumbnail: thumbnailUrl('look', 'original'),
} as const

/** The look a look layer came from, or undefined for any other clip and for a director's custom grade. */
export function lookIdOf(clip: Clip): string | undefined {
  const lookId = clip.type === 'adjustment' && clip.meta?.role === LOOK_ROLE ? clip.meta.lookId : undefined
  return typeof lookId === 'string' ? lookId : undefined
}

/** The look layer (adjustment clip) of a project and the look it came from, or null. */
export function currentLook(project: Project): { clipId: Id; lookId: string | undefined } | null {
  let director: Id | undefined
  for (const clip of Object.values(project.clips)) {
    if (clip.type !== 'adjustment') continue
    if (clip.meta?.role === LOOK_ROLE) return { clipId: clip.id, lookId: lookIdOf(clip) }
    if (directorMeta(clip)?.role === 'look') director ??= clip.id
  }
  return director ? { clipId: director, lookId: undefined } : null
}

/** The adjustment clip that carries a look's grade and effects. Unknown effect ids are left out. */
export function createLookClip(
  look: LookDefinition,
  o: { trackId: Id; start: Seconds; duration: Seconds },
  registry: PluginRegistry = pluginRegistry,
): AdjustmentClip {
  const { color: _color, ...base } = createSolidClip({ ...o, color: '#000000' })
  const adjustments: AdjustmentClip['adjustments'] = {}
  for (const [key, value] of Object.entries(look.adjustments) as [ColorAdjustmentKey, number][])
    if (value !== 0) adjustments[key] = { value: Math.max(-1, Math.min(1, value)) }
  const effects = look.effects
    .filter((e) => registry.get(e.effectId)?.kind === 'effect')
    .map((e) => {
      const instance = createEffectInstance(e.effectId, registry)
      for (const [key, value] of Object.entries(e.params ?? {}))
        if (instance.params[key]) instance.params[key] = { ...instance.params[key], value }
      return instance
    })
  return {
    ...base,
    type: 'adjustment',
    name: look.name,
    adjustments,
    effects,
    meta: { role: LOOK_ROLE, lookId: look.id },
  }
}

/** Index at which a new look track goes: below the top tracks that hold only text, so lyrics keep their colors. */
function lookTrackIndex(project: Project): number {
  let index = 0
  for (const track of project.tracks) {
    if (track.kind !== 'visual') break
    const clips = Object.values(project.clips).filter((c) => c.trackId === track.id)
    if (clips.length === 0 || clips.some((c) => c.type !== 'text')) break
    index++
  }
  return index
}

export interface ApplyLookOptions {
  /** Restyle text clips (default true). */
  text?: boolean
  /** Restyle existing transitions (default true). */
  transitions?: boolean
  /** Recolor visualizers and shader visuals (default true). */
  visualizers?: boolean
  registry?: PluginRegistry
  looks?: LookRegistry
  /** New track ids, for deterministic tests. */
  newTrack?: () => Track
}

/**
 * Edit commands that apply a look to the whole project. Dispatch them as one undo step. Clips on locked tracks are
 * left unchanged.
 */
export function applyLookCommands(
  project: Project,
  lookId: string,
  options: ApplyLookOptions = {},
): EditCommand[] {
  const look = (options.looks ?? lookRegistry).get(lookId)
  if (!look) throw new Error(`Unknown look "${lookId}"`)
  const registry = options.registry ?? pluginRegistry
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const commands: EditCommand[] = []

  const existing = currentLook(project)
  const existingClip = existing ? project.clips[existing.clipId] : undefined
  let trackId = existingClip && !locked.has(existingClip.trackId) ? existingClip.trackId : undefined
  if (existingClip && trackId) commands.push({ type: 'clip.remove', clipIds: [existingClip.id] })
  if (!trackId) {
    const track = options.newTrack?.() ?? createTrack('visual', LOOK_TRACK_NAME)
    commands.push({ type: 'track.add', track, index: lookTrackIndex(project) })
    trackId = track.id
  }
  const start = existingClip?.start ?? 0
  const duration = existingClip?.duration ?? Math.max(projectDuration(project), 10)
  const clip = createLookClip(look, { trackId, start, duration }, registry)
  // The layer's opacity is the look's intensity, which stays with the video when the look changes.
  if (existingClip && existingClip.type !== 'audio') clip.opacity = existingClip.opacity
  commands.push({ type: 'clip.add', clip })

  for (const clip of Object.values(project.clips)) {
    if (locked.has(clip.trackId) || clip.type === 'audio') continue
    if (clip.type === 'text' && options.text !== false) {
      commands.push({
        type: 'clip.set',
        clipId: clip.id,
        path: ['style'],
        value: {
          ...clip.style,
          // A look owns the typography: switching looks must not keep the previous look's italic, outline or glow.
          ...(look.text?.style ? { italic: false, stroke: undefined, shadow: undefined } : {}),
          ...look.text?.style,
          color: look.textColor,
        },
      })
      if (clip.karaoke)
        commands.push({
          type: 'clip.set',
          clipId: clip.id,
          path: ['karaoke', 'highlightColor'],
          value: look.accentColor,
        })
      const animation = look.text?.animation
      if (animation && registry.get(animation.presetId)?.kind === 'text-animation')
        commands.push({
          type: 'clip.set',
          clipId: clip.id,
          path: ['animation'],
          value: { presetId: animation.presetId, params: { ...animation.params } },
        })
    }
    if (clip.type === 'generator' && options.visualizers !== false) {
      const colors = lookPaletteParams(look, registry.get(clip.generatorId))
      for (const [key, value] of Object.entries(colors))
        commands.push({ type: 'clip.set', clipId: clip.id, path: ['params', key], value: { value } })
    }
    if (
      options.transitions !== false &&
      look.transition &&
      registry.get(look.transition.kind)?.kind === 'transition'
    ) {
      const style = createTransition(look.transition.kind, {}, registry)
      for (const key of ['transitionIn', 'transitionOut'] as const) {
        const current = clip[key]
        if (!current) continue
        commands.push({
          type: 'clip.set',
          clipId: clip.id,
          path: [key],
          value: { ...current, kind: style.kind, params: { ...style.params, ...look.transition.params } },
        })
      }
    }
  }
  return commands
}

/** A look's visualizer colors for a generator's color params: `color` gets the primary, `color2` the secondary. */
export function lookPaletteParams(
  look: LookDefinition,
  def: PluginDefinition | undefined,
): Record<string, string> {
  const colors: Record<string, string> = { color: look.palette.primary, color2: look.palette.secondary }
  const params: Record<string, string> = {}
  for (const spec of def?.params ?? []) {
    const value = colors[spec.key]
    if (spec.type === 'color' && value) params[spec.key] = value
  }
  return params
}

/** Applies a look as one undo step labeled with its name. */
export function applyLook(editor: ProjectEditor, lookId: string, options: ApplyLookOptions = {}): void {
  const look = (options.looks ?? lookRegistry).get(lookId)
  editor.dispatch(applyLookCommands(editor.getProject(), lookId, options), {
    label: `Apply look: ${look?.name ?? lookId}`,
  })
}

/** Removes the look layer (and its track when nothing else is on it). Text, transitions and colors stay as they are. */
export function removeLookCommands(project: Project): EditCommand[] {
  const existing = currentLook(project)
  const clip = existing ? project.clips[existing.clipId] : undefined
  if (!clip) return []
  const others = Object.values(project.clips).some((c) => c.trackId === clip.trackId && c.id !== clip.id)
  return others
    ? [{ type: 'clip.remove', clipIds: [clip.id] }]
    : [{ type: 'track.remove', trackId: clip.trackId }]
}

/**
 * Built-in looks. Ids are shared with the director's plans and VJ mode's look pads; VJ's "Original" pad is no look
 * (removeLookCommands).
 */
export const BUILTIN_LOOKS: LookDefinition[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Natural color with a little extra snap.',
    tags: ['clean', 'natural', 'simple', 'minimal'],
    adjustments: { contrast: 0.05 },
    effects: [],
    textColor: '#ffffff',
    accentColor: '#facc15',
    promptStyle: 'natural light, clean composition, high detail',
    palette: { primary: '#ffffff', secondary: '#facc15' },
    text: {
      style: { fontFamily: fontStack('Inter'), fontWeight: 700, textTransform: 'none', letterSpacing: 0 },
      animation: { presetId: 'rise' },
    },
    transition: { kind: 'fade' },
  },
  {
    id: 'neon',
    name: 'Neon night',
    description: 'Cool, saturated night tones with glowing highlights.',
    tags: ['neon', 'noir', 'cyberpunk', 'night', 'city', 'club', 'electronic', 'synth'],
    adjustments: { contrast: 0.15, saturation: 0.2, temperature: -0.08 },
    effects: [
      { effectId: 'color-grade', params: { look: 'neon', amount: 0.55 } },
      { effectId: 'glow', params: { intensity: 0.95 } },
    ],
    textColor: '#f5f3ff',
    accentColor: '#22d3ee',
    promptStyle: 'neon-lit night, magenta and cyan light, reflections on wet streets, cinematic',
    palette: { primary: '#22d3ee', secondary: '#f472b6' },
    text: {
      style: {
        fontFamily: fontStack('Montserrat'),
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: 0.06,
        shadow: { color: '#22d3eecc', blur: 24, offsetX: 0, offsetY: 0 },
      },
      animation: { presetId: 'flicker' },
    },
    transition: { kind: 'flash', params: { color: '#a5f3fc' } },
  },
  {
    id: 'warm',
    name: 'Golden hour',
    description: 'Warm sunlit tones.',
    tags: ['warm', 'sunset', 'summer', 'golden', 'beach', 'sun', 'happy'],
    adjustments: { temperature: 0.06, contrast: 0.05 },
    effects: [
      { effectId: 'color-grade', params: { look: 'golden', amount: 0.65 } },
      { effectId: 'light-leak', params: { intensity: 0.25 } },
      { effectId: 'glow', params: { intensity: 0.4, threshold: 0.75 } },
    ],
    textColor: '#fffbeb',
    accentColor: '#fb923c',
    promptStyle: 'golden hour sunlight, warm tones, soft lens flare, cinematic',
    palette: { primary: '#fde68a', secondary: '#fb923c' },
    text: {
      style: {
        fontFamily: fontStack('DM Serif Display'),
        fontWeight: 400,
        textTransform: 'none',
        letterSpacing: 0.01,
      },
      animation: { presetId: 'rise' },
    },
    transition: { kind: 'light-burn' },
  },
  {
    id: 'vintage',
    name: 'Vintage film',
    description: 'Faded 35 mm color with grain and soft edges.',
    tags: ['vintage', 'retro', 'film', '70s', 'nostalgic', 'old', 'analog'],
    adjustments: { contrast: -0.05, saturation: -0.15, temperature: 0.1 },
    effects: [
      { effectId: 'color-grade', params: { look: 'vintage', amount: 0.75 } },
      { effectId: 'film-grain', params: { amount: 0.3 } },
      { effectId: 'vignette', params: { amount: 0.35 } },
    ],
    textColor: '#fef3c7',
    accentColor: '#f87171',
    promptStyle: 'shot on 35mm film, faded colors, grain, nostalgic',
    palette: { primary: '#fef3c7', secondary: '#f87171' },
    text: {
      style: {
        fontFamily: fontStack('Playfair Display'),
        fontWeight: 600,
        textTransform: 'none',
        letterSpacing: 0.04,
      },
      animation: { presetId: 'typewriter', params: { cursor: false } },
    },
    transition: { kind: 'dip' },
  },
  {
    id: 'moody',
    name: 'Moody',
    description: 'Low-key, muted and dark.',
    tags: ['dark', 'moody', 'sad', 'melancholy', 'lonely', 'rain', 'night'],
    adjustments: { exposure: -0.04, saturation: -0.3, contrast: 0.15 },
    effects: [
      { effectId: 'color-grade', params: { look: 'cool-night', amount: 0.4 } },
      { effectId: 'vignette', params: { amount: 0.35 } },
    ],
    textColor: '#e5e7eb',
    accentColor: '#93c5fd',
    promptStyle: 'low-key lighting, deep shadows, muted colors, atmospheric',
    palette: { primary: '#e5e7eb', secondary: '#93c5fd' },
    text: {
      style: {
        fontFamily: fontStack('Space Grotesk'),
        fontWeight: 400,
        textTransform: 'lowercase',
        letterSpacing: 0.08,
      },
      animation: { presetId: 'blur-in' },
    },
    transition: { kind: 'dip' },
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    description: 'Soft, hazy and bright.',
    tags: ['dream', 'dreamy', 'soft', 'ethereal', 'calm', 'love', 'romantic', 'pastel'],
    adjustments: { contrast: -0.1, brightness: 0.05, saturation: -0.05 },
    effects: [
      { effectId: 'color-grade', params: { look: 'pastel', amount: 0.6 } },
      { effectId: 'glow', params: { intensity: 0.6 } },
      { effectId: 'light-leak', params: { intensity: 0.25, color: '#ff9ad5', color2: '#b49cff' } },
    ],
    textColor: '#fdf4ff',
    accentColor: '#f0abfc',
    promptStyle: 'soft focus, pastel colors, hazy light, dreamlike',
    palette: { primary: '#fdf4ff', secondary: '#f0abfc' },
    text: {
      style: {
        fontFamily: fontStack('Playfair Display'),
        fontWeight: 500,
        italic: true,
        textTransform: 'none',
        letterSpacing: 0.02,
      },
      animation: { presetId: 'wave', params: { amplitude: 0.1, speed: 0.5 } },
    },
    transition: { kind: 'fade' },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'High-contrast black and white with fine grain.',
    tags: ['black and white', 'monochrome', 'mono', 'b&w', 'grayscale', 'noir'],
    adjustments: { saturation: -1, contrast: 0.08 },
    effects: [
      { effectId: 'color-grade', params: { look: 'noir', amount: 1 } },
      { effectId: 'film-grain', params: { amount: 0.2 } },
    ],
    textColor: '#ffffff',
    accentColor: '#d4d4d4',
    promptStyle: 'black and white photography, high contrast, dramatic',
    palette: { primary: '#ffffff', secondary: '#a3a3a3' },
    text: {
      style: {
        fontFamily: fontStack('Oswald'),
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.1,
      },
      animation: { presetId: 'slide-in' },
    },
    transition: { kind: 'iris' },
  },
  {
    id: 'vivid',
    name: 'Vivid',
    description: 'Bold, saturated party color.',
    tags: ['energetic', 'party', 'hype', 'bright', 'colorful', 'pop', 'dance', 'fun'],
    adjustments: { saturation: 0.3, contrast: 0.1 },
    effects: [{ effectId: 'color-grade', params: { look: 'neon', amount: 0.35 } }],
    textColor: '#ffffff',
    accentColor: '#f472b6',
    promptStyle: 'vibrant saturated colors, bold, high energy',
    palette: { primary: '#f472b6', secondary: '#facc15' },
    text: {
      style: {
        fontFamily: fontStack('Anton'),
        fontWeight: 400,
        textTransform: 'uppercase',
        letterSpacing: 0.02,
        stroke: { color: '#000000', width: 6 },
      },
      animation: { presetId: 'bounce' },
    },
    transition: { kind: 'zoom-blur' },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Restrained film color with a gentle vignette.',
    tags: ['cinematic', 'epic', 'movie', 'film', 'dramatic', 'story'],
    adjustments: { contrast: 0.08, saturation: -0.05, temperature: 0.05 },
    effects: [
      { effectId: 'color-grade', params: { look: 'teal-orange', amount: 0.7 } },
      { effectId: 'vignette', params: { amount: 0.3 } },
    ],
    textColor: '#ffffff',
    accentColor: '#fbbf24',
    promptStyle: 'cinematic lighting, anamorphic lens, shallow depth of field, film still',
    palette: { primary: '#ffffff', secondary: '#fbbf24' },
    text: {
      style: {
        fontFamily: fontStack('Montserrat'),
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: 0.18,
      },
      animation: { presetId: 'blur-in' },
    },
    transition: { kind: 'dip' },
  },
  {
    id: 'vhs',
    name: 'VHS',
    description: 'Washed-out tape color with split channels and grain.',
    tags: ['vhs', 'tape', '80s', '90s', 'retro', 'camcorder', 'lo-fi'],
    adjustments: { saturation: 0.35, contrast: -0.1, brightness: 0.03 },
    effects: [
      { effectId: 'vhs', params: { amount: 0.7 } },
      { effectId: 'vignette', params: { amount: 0.3 } },
    ],
    textColor: '#ffffff',
    accentColor: '#facc15',
    promptStyle: 'VHS camcorder footage, 1990s, washed-out colors, scan lines, lo-fi',
    palette: { primary: '#ffffff', secondary: '#facc15' },
    text: {
      style: {
        fontFamily: fontStack('Space Grotesk'),
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.05,
        shadow: { color: '#ff00aa', blur: 0, offsetX: 3, offsetY: 0 },
      },
      animation: { presetId: 'typewriter' },
    },
    transition: { kind: 'glitch-cut' },
  },
  {
    id: 'ice',
    name: 'Ice',
    description: 'Cold blue tones, bright and crisp.',
    tags: ['cold', 'ice', 'winter', 'blue', 'frozen', 'clean', 'icy'],
    adjustments: { temperature: -0.35, tint: -0.05, saturation: -0.2, contrast: 0.1 },
    effects: [
      { effectId: 'color-grade', params: { look: 'cool-night', amount: 0.4 } },
      { effectId: 'glow', params: { intensity: 0.35, threshold: 0.8, tint: '#cfefff' } },
    ],
    textColor: '#f0f9ff',
    accentColor: '#7dd3fc',
    promptStyle: 'icy blue color palette, cold light, frost, crisp winter air',
    palette: { primary: '#e0f2fe', secondary: '#7dd3fc' },
    text: {
      style: {
        fontFamily: fontStack('Montserrat'),
        fontWeight: 400,
        textTransform: 'uppercase',
        letterSpacing: 0.14,
      },
      animation: { presetId: 'rise' },
    },
    transition: { kind: 'luma-wipe' },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Fiery reds and oranges with deep shadows.',
    tags: ['fire', 'ember', 'red', 'hot', 'intense', 'passion', 'warm', 'rage'],
    adjustments: { temperature: 0.4, tint: 0.08, saturation: 0.3, contrast: 0.15, exposure: -0.05 },
    effects: [
      { effectId: 'color-grade', params: { look: 'warm-film', amount: 0.6 } },
      { effectId: 'glow', params: { intensity: 0.9, threshold: 0.6, tint: '#ffb070' } },
      { effectId: 'vignette', params: { amount: 0.45, color: '#1a0500' } },
    ],
    textColor: '#fff7ed',
    accentColor: '#f97316',
    promptStyle: 'fiery red and orange light, embers and sparks, deep shadows, intense',
    palette: { primary: '#fdba74', secondary: '#ef4444' },
    text: {
      style: {
        fontFamily: fontStack('Anton'),
        fontWeight: 400,
        textTransform: 'uppercase',
        letterSpacing: 0.03,
        shadow: { color: '#f97316aa', blur: 20, offsetX: 0, offsetY: 0 },
      },
      animation: { presetId: 'stamp' },
    },
    transition: { kind: 'noise-dissolve', params: { edgeColor: '#ff7a1a' } },
  },
]

for (const look of BUILTIN_LOOKS) look.thumbnail ??= thumbnailUrl('look', look.id)

/** The app-wide look registry with the built-in looks. */
export const lookRegistry: LookRegistry = createLookRegistry()
