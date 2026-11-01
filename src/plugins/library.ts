/**
 * Creates project content from library items: effect instances, generator clips and transitions with every param
 * written out (so a project keeps its look if a default changes later) and the item's default audio mappings, which
 * the inspector then shows and edits like any other modulation.
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { PluginDefinition, PluginRegistry } from '../engine/types.ts'
import { createSolidClip, newId } from '../model/factory.ts'
import type {
  Animatable,
  EffectInstance,
  GeneratorClip,
  Id,
  ParamValue,
  Seconds,
  Transition,
} from '../model/types.ts'

/** Every param of a plugin at its default value, with the plugin's default audio mappings attached. */
export function defaultParams(def: PluginDefinition): Record<string, Animatable<ParamValue>> {
  const params: Record<string, Animatable<ParamValue>> = {}
  for (const spec of def.params) {
    const modulation = def.defaultModulation?.[spec.key]
    params[spec.key] = modulation
      ? { value: spec.default, modulation: modulation.map((m) => ({ ...m, source: { ...m.source } })) }
      : { value: spec.default }
  }
  return params
}

function definition<K extends PluginDefinition['kind']>(
  registry: PluginRegistry,
  id: string,
  kind: K,
): Extract<PluginDefinition, { kind: K }> {
  const def = registry.get(id)
  if (def?.kind !== kind) throw new Error(`No ${kind} plugin “${id}”`)
  return def as Extract<PluginDefinition, { kind: K }>
}

export function createEffectInstance(
  effectId: string,
  registry: PluginRegistry = pluginRegistry,
): EffectInstance {
  const def = definition(registry, effectId, 'effect')
  return { id: newId(), effectId, enabled: true, params: defaultParams(def) }
}

export function createGeneratorClip(
  o: { trackId: Id; generatorId: string; start: Seconds; duration: Seconds },
  registry: PluginRegistry = pluginRegistry,
): GeneratorClip {
  const def = definition(registry, o.generatorId, 'generator')
  const { color: _color, ...base } = createSolidClip({ ...o, color: '#000000' })
  return { ...base, type: 'generator', generatorId: o.generatorId, params: defaultParams(def) }
}

/** A transition with its suggested duration (or `duration`, e.g. one beat) and every param written out. */
export function createTransition(
  kind: string,
  options: { duration?: Seconds } = {},
  registry: PluginRegistry = pluginRegistry,
): Transition {
  const def = definition(registry, kind, 'transition')
  const params: Record<string, ParamValue> = {}
  for (const spec of def.params) params[spec.key] = spec.default
  return { kind, duration: options.duration ?? def.defaultDuration ?? 0.5, easing: 'ease-in-out', params }
}
