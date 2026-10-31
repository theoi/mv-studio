/**
 * Looks offered on the VJ looks row: a fixed pick from the shared looks catalog, in pad order. Only their grade and
 * effects are used; VJ plays them as time-ranged adjustment clips on its own track, not as the project look layer.
 */
import { lookRegistry, type LookDefinition, type LookRegistry } from '../plugins/looks.ts'

export type VjLookPreset = Pick<LookDefinition, 'id' | 'name' | 'adjustments' | 'effects'>

export const VJ_LOOK_IDS = ['neon', 'warm', 'vhs', 'mono', 'dreamy', 'ice', 'ember'] as const

export function availableLooks(registry: LookRegistry = lookRegistry): VjLookPreset[] {
  return VJ_LOOK_IDS.flatMap((id) => {
    const look = registry.get(id)
    return look
      ? [{ id: look.id, name: look.name, adjustments: look.adjustments, effects: look.effects }]
      : []
  })
}
