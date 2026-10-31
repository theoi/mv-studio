/**
 * What the director may use: effects, transitions, generators, text animations and looks, by id. DEFAULT_CATALOG
 * comes from the engine's plugin registry, so plans only reference plugins that exist; director tags (moods a plugin
 * suits) are layered on top. Looks come from the shared look registry. Pass catalogFromPlugins(registry.catalog()) to
 * include plugins and looks added later. Unknown ids are dropped at compile time with a warning.
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginCatalogEntry } from '../engine/types.ts'
import type { ParamValue } from '../model/types.ts'
import { lookRegistry, type LookDefinition } from '../plugins/looks.ts'

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

/** The parts of a look (src/plugins/looks.ts) the director uses. */
export type LookPreset = Pick<
  LookDefinition,
  'id' | 'name' | 'tags' | 'adjustments' | 'effects' | 'textColor' | 'accentColor' | 'promptStyle'
> &
  Partial<Pick<LookDefinition, 'palette' | 'text'>>

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
  'visualizer.circle': ['energetic', 'peak', 'punchy', 'bass', 'radial', 'electronic'],
  'visualizer.orb': ['driving', 'steady', 'dreamy', 'liquid', 'ambient'],
  'generator.tunnel': ['energetic', 'peak', 'rising', 'hypnotic', 'neon', 'tunnel', 'electronic'],
  'generator.starfield': ['driving', 'steady', 'rising', 'space', 'stars', 'flight'],
  'generator.synthwave': ['driving', 'energetic', 'retro', 'synthwave', '80s', 'neon', 'grid'],
  'generator.geometry': ['steady', 'hypnotic', 'minimal', 'geometry', 'neon'],
  'generator.nebula': ['calm', 'dreamy', 'soft', 'ethereal', 'space', 'cosmic', 'ambient'],
  'generator.aurora': ['calm', 'soft', 'falling', 'dreamy', 'night', 'sky', 'ambient'],
  'generator.gradient': ['calm', 'soft', 'minimal', 'pastel', 'background'],
  pop: ['energetic', 'peak', 'punchy', 'rising'],
  'fade-up': ['calm', 'steady', 'soft', 'falling', 'dreamy'],
  typewriter: ['minimal', 'vintage'],
}

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
  looks: LookPreset[] = lookRegistry.list(),
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
