/**
 * Plugin registry: effects, transitions, generators and text animation presets, looked up by the id stored in
 * projects. catalog() describes them (without code) for the inspector UI and the director.
 */
import type { Animatable, ParamValue, Seconds } from '../model/types.ts'
import { evaluateParam } from './animation.ts'
import type { AudioSampler } from './audioFeatures.ts'
import { isHexColor } from './color.ts'
import { PLUGINS } from '../plugins/index.ts'
import { BUILTIN_PLUGINS } from './plugins/index.ts'
import type {
  ParamSpec,
  PluginCatalogEntry,
  PluginDefinition,
  PluginKind,
  PluginRegistry,
  ResolvedParams,
} from './types.ts'

export function catalogEntry(plugin: PluginDefinition): PluginCatalogEntry {
  const numeric = plugin.params.filter((p) => p.type === 'number')
  return {
    id: plugin.id,
    kind: plugin.kind,
    name: plugin.name,
    category: plugin.category,
    description: plugin.description,
    params: plugin.params,
    animatable: numeric.filter((p) => p.animatable !== false).map((p) => p.key),
    modulatable: numeric.filter((p) => p.modulatable !== false).map((p) => p.key),
  }
}

class Registry implements PluginRegistry {
  private readonly plugins = new Map<string, PluginDefinition>()
  private readonly listeners = new Set<() => void>()
  private catalogCache: PluginCatalogEntry[] | null = null

  register(plugin: PluginDefinition): void {
    if (!plugin.id) throw new Error('Plugin id is required')
    const keys = new Set<string>()
    for (const p of plugin.params) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key))
        throw new Error(`${plugin.id}: invalid param key "${p.key}"`)
      if (keys.has(p.key)) throw new Error(`${plugin.id}: duplicate param key "${p.key}"`)
      keys.add(p.key)
    }
    this.plugins.set(plugin.id, plugin)
    this.catalogCache = null
    for (const listener of this.listeners) listener()
  }

  get(id: string): PluginDefinition | undefined {
    return this.plugins.get(id)
  }

  list(kind?: PluginKind): PluginDefinition[] {
    const all = [...this.plugins.values()]
    return kind ? all.filter((p) => p.kind === kind) : all
  }

  catalog(kind?: PluginKind): PluginCatalogEntry[] {
    this.catalogCache ??= this.list().map(catalogEntry)
    return kind ? this.catalogCache.filter((e) => e.kind === kind) : this.catalogCache
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function createPluginRegistry(options: { builtins?: boolean } = {}): PluginRegistry {
  const registry = new Registry()
  if (options.builtins !== false)
    for (const plugin of [...BUILTIN_PLUGINS, ...PLUGINS]) registry.register(plugin)
  return registry
}

/** The app-wide registry with the built-in plugins. */
export const pluginRegistry: PluginRegistry = createPluginRegistry()

/** Coerces a value to its spec's type, falling back to the default; numbers are clamped to the spec range. */
export function coerceParam(spec: ParamSpec, value: ParamValue | undefined): ParamValue {
  switch (spec.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(spec.max, Math.max(spec.min, value))
        : spec.default
    case 'boolean':
      return typeof value === 'boolean' ? value : spec.default
    case 'color':
      return isHexColor(value) ? value : spec.default
    case 'select':
      return typeof value === 'string' && spec.options.some((o) => o.value === value) ? value : spec.default
  }
}

/** Parameter values for one frame: defaults, overridden by the instance's keyframed and audio-modulated values. */
export function resolveParams(
  specs: readonly ParamSpec[],
  values: Record<string, Animatable<ParamValue>> | undefined,
  localTime: Seconds,
  time: Seconds,
  audio?: AudioSampler,
): ResolvedParams {
  const out: ResolvedParams = {}
  for (const spec of specs) {
    const anim = values?.[spec.key]
    out[spec.key] = coerceParam(spec, anim ? evaluateParam(anim, localTime, time, audio) : undefined)
  }
  return out
}

/** Like resolveParams, for plain (non-animated) values such as transition and text preset params. */
export function resolveStaticParams(
  specs: readonly ParamSpec[],
  values: Record<string, ParamValue> | undefined,
): ResolvedParams {
  const out: ResolvedParams = {}
  for (const spec of specs) out[spec.key] = coerceParam(spec, values?.[spec.key])
  return out
}
