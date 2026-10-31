import { describe, expect, it } from 'vitest'
import { bestByTags, catalogFromPlugins, DEFAULT_CATALOG } from '../../../src/director/index.ts'
import type { PluginCatalogEntry } from '../../../src/engine/types.ts'

const entry = (
  id: string,
  kind: PluginCatalogEntry['kind'],
  extra: Partial<PluginCatalogEntry> = {},
): PluginCatalogEntry => ({
  id,
  kind,
  name: id,
  category: 'Stylize',
  params: [],
  animatable: [],
  modulatable: [],
  ...extra,
})

describe('catalogFromPlugins', () => {
  it('gives library plugins their own mood tags so planners can pick them', () => {
    const catalog = catalogFromPlugins([
      entry('glow', 'effect'),
      entry('chromatic-burst', 'effect', { tags: ['glitch', 'peak'] }),
      entry('paper', 'effect'),
      entry('spin', 'text-animation', { tags: ['energetic'] }),
    ])
    expect(catalog.effects.map((e) => e.tags)).toEqual([
      DEFAULT_CATALOG.effects.find((e) => e.id === 'glow')!.tags,
      ['glitch', 'peak'],
      ['stylize'],
    ])
    expect(catalog.textPresets[0]?.id).toBe('spin')
    expect(bestByTags(catalog.effects.slice(1), ['peak'])?.id).toBe('chromatic-burst')
  })
})
