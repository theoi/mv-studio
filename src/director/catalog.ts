/**
 * What the director may use: effects, transitions, generators, text animations and looks, by id. DEFAULT_CATALOG
 * comes from the engine's plugin registry, so plans only reference plugins that exist; director tags (moods a plugin
 * suits) are layered on top. Pass catalogFromPlugins(registry.catalog()) to include plugins added later. Unknown ids
 * are dropped at compile time with a warning.
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginCatalogEntry } from '../engine/types.ts'
import type { ColorAdjustmentKey, ParamValue } from '../model/types.ts'

export interface CatalogParam {
  key: string
  default: ParamValue
  min?: number
  max?: number
  /** Whether audio modulation can drive it. */
  modulatable?: boolean
}

export interface CatalogItem {
  id: string
  name: string
  /** Words planners match against moods and prompts, e.g. ['energetic', 'punchy']. */
  tags: string[]
  description?: string
  params?: CatalogParam[]
}

export interface LookPreset {
  id: string
  name: string
  tags: string[]
  adjustments: Partial<Record<ColorAdjustmentKey, number>>
  effects: { effectId: string; params?: Record<string, ParamValue> }[]
  /** Default text colors that suit the look. */
  textColor: string
  accentColor: string
  /** Appended to generation prompts so shots share one visual style. */
  promptStyle: string
}

export interface DirectorCatalog {
  effects: CatalogItem[]
  transitions: CatalogItem[]
  generators: CatalogItem[]
  textPresets: CatalogItem[]
  looks: LookPreset[]
}

/** Moods each built-in plugin suits. Other plugins use their own catalog tags, else their category. */
export const DIRECTOR_TAGS: Record<string, string[]> = {
  glow: ['energetic', 'dreamy', 'neon', 'peak'],
  blur: ['dreamy', 'soft', 'background'],
  'rgb-split': ['glitch', 'energetic', 'peak'],
  vignette: ['cinematic', 'moody', 'vintage'],
  'film-grain': ['vintage', 'cinematic'],
  fade: ['calm', 'soft', 'falling'],
  flash: ['energetic', 'rising', 'peak'],
  zoom: ['energetic', 'rising'],
  'wipe-left': ['steady'],
  'visualizer.spectrum': ['energetic', 'punchy', 'electronic', 'peak', 'rising'],
  'visualizer.waveform': ['calm', 'minimal', 'steady', 'soft', 'falling'],
  'visualizer.particles': ['dreamy', 'peak', 'ethereal'],
  pop: ['energetic', 'peak', 'punchy', 'rising'],
  'fade-up': ['calm', 'steady', 'soft', 'falling', 'dreamy'],
  typewriter: ['minimal', 'vintage'],
}

export const DEFAULT_LOOKS: LookPreset[] = [
  {
    id: 'clean',
    name: 'Clean',
    tags: ['clean', 'natural', 'simple'],
    adjustments: { contrast: 0.05 },
    effects: [],
    textColor: '#ffffff',
    accentColor: '#facc15',
    promptStyle: 'natural light, clean composition, high detail',
  },
  {
    id: 'neon',
    name: 'Neon night',
    tags: ['neon', 'cyberpunk', 'night', 'city', 'club', 'electronic', 'synth'],
    adjustments: { contrast: 0.15, saturation: 0.25, temperature: -0.15 },
    effects: [{ effectId: 'glow', params: { intensity: 0.8 } }],
    textColor: '#f5f3ff',
    accentColor: '#22d3ee',
    promptStyle: 'neon-lit night, magenta and cyan light, reflections on wet streets, cinematic',
  },
  {
    id: 'warm',
    name: 'Golden hour',
    tags: ['warm', 'sunset', 'summer', 'golden', 'beach', 'sun', 'happy'],
    adjustments: { temperature: 0.25, saturation: 0.1, contrast: 0.05 },
    effects: [],
    textColor: '#fffbeb',
    accentColor: '#fb923c',
    promptStyle: 'golden hour sunlight, warm tones, soft lens flare, cinematic',
  },
  {
    id: 'vintage',
    name: 'Vintage film',
    tags: ['vintage', 'retro', 'film', '70s', '80s', '90s', 'vhs', 'nostalgic', 'old'],
    adjustments: { contrast: -0.05, saturation: -0.15, temperature: 0.1 },
    effects: [
      { effectId: 'film-grain', params: { amount: 0.3 } },
      { effectId: 'vignette', params: { amount: 0.35 } },
    ],
    textColor: '#fef3c7',
    accentColor: '#f87171',
    promptStyle: 'shot on 35mm film, faded colors, grain, nostalgic',
  },
  {
    id: 'moody',
    name: 'Moody',
    tags: ['dark', 'moody', 'noir', 'sad', 'melancholy', 'lonely', 'rain', 'night'],
    adjustments: { exposure: -0.1, saturation: -0.3, contrast: 0.15 },
    effects: [{ effectId: 'vignette', params: { amount: 0.5 } }],
    textColor: '#e5e7eb',
    accentColor: '#93c5fd',
    promptStyle: 'low-key lighting, deep shadows, muted colors, atmospheric',
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    tags: ['dream', 'dreamy', 'soft', 'ethereal', 'calm', 'love', 'romantic', 'pastel'],
    adjustments: { contrast: -0.1, brightness: 0.05, saturation: -0.05 },
    effects: [{ effectId: 'glow', params: { intensity: 0.6 } }],
    textColor: '#fdf4ff',
    accentColor: '#f0abfc',
    promptStyle: 'soft focus, pastel colors, hazy light, dreamlike',
  },
  {
    id: 'mono',
    name: 'Black and white',
    tags: ['black and white', 'monochrome', 'mono', 'b&w', 'grayscale'],
    adjustments: { saturation: -1, contrast: 0.2 },
    effects: [{ effectId: 'film-grain', params: { amount: 0.2 } }],
    textColor: '#ffffff',
    accentColor: '#d4d4d4',
    promptStyle: 'black and white photography, high contrast, dramatic',
  },
  {
    id: 'vivid',
    name: 'Vivid',
    tags: ['energetic', 'party', 'hype', 'bright', 'colorful', 'pop', 'dance', 'fun'],
    adjustments: { saturation: 0.3, contrast: 0.1 },
    effects: [],
    textColor: '#ffffff',
    accentColor: '#f472b6',
    promptStyle: 'vibrant saturated colors, bold, high energy',
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    tags: ['cinematic', 'epic', 'movie', 'film', 'dramatic', 'story'],
    adjustments: { contrast: 0.08, saturation: -0.05, temperature: 0.05 },
    effects: [{ effectId: 'vignette', params: { amount: 0.3 } }],
    textColor: '#ffffff',
    accentColor: '#fbbf24',
    promptStyle: 'cinematic lighting, anamorphic lens, shallow depth of field, film still',
  },
]

function toItem(entry: PluginCatalogEntry): CatalogItem {
  return {
    id: entry.id,
    name: entry.name,
    tags: DIRECTOR_TAGS[entry.id] ?? (entry.tags?.length ? entry.tags : [entry.category.toLowerCase()]),
    ...(entry.description ? { description: entry.description } : {}),
    params: entry.params.map((p) =>
      p.type === 'number'
        ? {
            key: p.key,
            default: p.default,
            min: p.min,
            max: p.max,
            modulatable: entry.modulatable.includes(p.key),
          }
        : { key: p.key, default: p.default },
    ),
  }
}

/** Builds a catalog from the engine's plugin catalog (registry.catalog()). */
export function catalogFromPlugins(
  entries: readonly PluginCatalogEntry[],
  looks: LookPreset[] = DEFAULT_LOOKS,
): DirectorCatalog {
  const of = (kind: PluginCatalogEntry['kind']) => entries.filter((e) => e.kind === kind).map(toItem)
  return {
    effects: of('effect'),
    transitions: of('transition'),
    generators: of('generator'),
    textPresets: of('text-animation'),
    looks,
  }
}

export const DEFAULT_CATALOG: DirectorCatalog = catalogFromPlugins(pluginRegistry.catalog())

export function findItem(list: CatalogItem[], id: string | undefined): CatalogItem | undefined {
  return id ? list.find((i) => i.id === id) : undefined
}

/** The item whose tags best match any of `words`, or undefined when nothing matches. */
export function bestByTags<T extends { tags: string[] }>(list: T[], words: string[]): T | undefined {
  let best: T | undefined
  let bestScore = 0
  for (const item of list) {
    const score = words.reduce((s, w) => s + (item.tags.includes(w) ? 1 : 0), 0)
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}
