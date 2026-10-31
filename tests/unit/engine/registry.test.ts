import { describe, expect, it, vi } from 'vitest'
import { createPluginRegistry, resolveParams, resolveStaticParams } from '../../../src/engine/registry.ts'
import type { EffectDefinition, ParamSpec } from '../../../src/engine/types.ts'

describe('plugin registry', () => {
  it('ships the built-in plugins the director and the UI rely on', () => {
    const registry = createPluginRegistry()
    const byKind = (kind: Parameters<typeof registry.catalog>[0]) =>
      registry
        .catalog(kind)
        .map((e) => e.id)
        .sort()
    // Other plugins (src/plugins) may add more; these ids must always be there.
    expect(byKind('transition')).toEqual(expect.arrayContaining(['fade', 'flash', 'wipe-left', 'zoom']))
    expect(byKind('effect')).toEqual(
      expect.arrayContaining(['blur', 'film-grain', 'glow', 'rgb-split', 'vignette']),
    )
    expect(byKind('generator')).toEqual(
      expect.arrayContaining(['visualizer.particles', 'visualizer.spectrum', 'visualizer.waveform']),
    )
    expect(byKind('text-animation')).toEqual(expect.arrayContaining(['fade-up', 'pop', 'typewriter']))
  })

  it('lists which numeric params accept keyframes and audio modulation', () => {
    const spectrum = createPluginRegistry()
      .catalog('generator')
      .find((e) => e.id === 'visualizer.spectrum')
    expect(spectrum?.animatable).toEqual(['height', 'gap'])
    expect(spectrum?.modulatable).toEqual(['height', 'gap'])
  })

  it('validates param keys, replaces plugins by id and notifies subscribers', () => {
    const registry = createPluginRegistry({ builtins: false })
    const listener = vi.fn()
    registry.subscribe(listener)
    const effect: EffectDefinition = {
      kind: 'effect',
      id: 'test',
      name: 'Test',
      category: 'Test',
      params: [],
      fragmentShader: 'vec4 mainImage(vec2 uv) { return texture(u_input, uv); }',
    }
    registry.register(effect)
    expect(registry.catalog().map((e) => e.name)).toEqual(['Test'])
    registry.register({ ...effect, name: 'Renamed' })
    expect(registry.catalog().map((e) => e.name)).toEqual(['Renamed'])
    expect(listener).toHaveBeenCalledTimes(2)
    const bad = (key: string) => ({
      ...effect,
      params: [{ key, label: key, type: 'boolean', default: false }] as ParamSpec[],
    })
    expect(() => registry.register(bad('has space'))).toThrow(/invalid param key/)
    const dup: ParamSpec = { key: 'a', label: 'a', type: 'boolean', default: false }
    expect(() => registry.register({ ...effect, params: [dup, dup] })).toThrow(/duplicate/)
  })
})

describe('resolveParams', () => {
  const specs: ParamSpec[] = [
    { key: 'amount', label: 'Amount', type: 'number', default: 1, min: 0, max: 10 },
    { key: 'on', label: 'On', type: 'boolean', default: true },
    { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ]

  it('applies keyframes, clamps numbers to the spec range and falls back to defaults', () => {
    const params = resolveParams(
      specs,
      {
        amount: {
          value: 0,
          keyframes: [
            { time: 0, value: 2, easing: 'linear' },
            { time: 2, value: 6, easing: 'linear' },
          ],
        },
        on: { value: 'yes' },
        mode: { value: 'zzz' },
      },
      1,
      1,
    )
    expect(params).toEqual({ amount: 4, on: true, tint: '#ffffff', mode: 'a' })
    expect(resolveParams(specs, { amount: { value: 50 }, tint: { value: '#ff0000' } }, 0, 0)).toMatchObject({
      amount: 10,
      tint: '#ff0000',
    })
    expect(resolveStaticParams(specs, { amount: -3, mode: 'b' })).toMatchObject({ amount: 0, mode: 'b' })
  })
})
