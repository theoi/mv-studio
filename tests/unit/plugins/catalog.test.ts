import { describe, expect, it } from 'vitest'
import { createPluginRegistry } from '../../../src/engine/registry.ts'
import { PLUGINS } from '../../../src/plugins/index.ts'

const registry = createPluginRegistry()

describe('plugin library conventions', () => {
  it('describes every library item for search, badges and the inspector', () => {
    expect(PLUGINS.length).toBeGreaterThan(40)
    for (const plugin of PLUGINS) {
      expect(plugin.description, plugin.id).toBeTruthy()
      expect(plugin.tags?.length, plugin.id).toBeGreaterThan(0)
      expect(plugin.cost, plugin.id).toBeDefined()
      const pattern =
        plugin.kind === 'generator' ? /^(visualizer|generator)\.[a-z0-9-]+$/ : /^[a-z0-9]+(-[a-z0-9]+)*$/
      expect(plugin.id).toMatch(pattern)
      for (const p of plugin.params)
        if (p.type === 'number') {
          expect(p.default, `${plugin.id}.${p.key}`).toBeGreaterThanOrEqual(p.min)
          expect(p.default, `${plugin.id}.${p.key}`).toBeLessThanOrEqual(p.max)
        }
    }
  })

  it('gives every visual the two palette colors that looks restyle', () => {
    const generators = registry.list('generator')
    expect(generators.length).toBeGreaterThanOrEqual(12)
    for (const g of generators)
      for (const key of ['color', 'color2'])
        expect(g.params.find((p) => p.key === key)?.type, `${g.id}.${key}`).toBe('color')
  })
})
