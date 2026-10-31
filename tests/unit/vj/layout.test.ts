import { describe, expect, it } from 'vitest'
import { catalogEntry } from '../../../src/engine/registry.ts'
import type { PluginCatalogEntry } from '../../../src/engine/types.ts'
import {
  LAYOUT_EXTENSION_KEY,
  defaultLayout,
  effectTarget,
  layoutForProject,
  parseLayout,
  reconcileLayout,
  type VjLayout,
} from '../../../src/vj/index.ts'
import { asset, catalog, makeProject } from './helpers.ts'

const labels = (row: ({ label: string } | null)[] | undefined) => (row ?? []).map((p) => p?.label ?? null)

describe('default layout', () => {
  it('puts the media first (oldest first), then visualizers, performance effects and looks', () => {
    const layout = defaultLayout(makeProject(), catalog)
    expect(labels(layout.clipBanks[0])).toEqual([
      'Night city',
      'Singer',
      'Sunset',
      'Spectrum bars',
      'Waveform line',
      'Particles',
      null,
      null,
      null,
      null,
    ])
    expect(labels(layout.effects)).toEqual([
      'Strobe',
      'RGB split',
      'Glow',
      'Blur',
      'Mono',
      'Flash',
      'Hue shift',
      'Vignette',
      'Freeze',
    ])
    expect(labels(layout.looks)).toEqual([
      'Original',
      'Neon night',
      'Golden hour',
      'VHS',
      'Mono',
      'Dreamy',
      'Ice',
      'Ember',
    ])
    const triggers = layout.effects.map((p) => (p?.action.kind === 'effect' ? p.action.trigger : null))
    expect(triggers).toEqual([
      'hold',
      'one-shot',
      'hold',
      'hold',
      'hold',
      'one-shot',
      'hold',
      'toggle',
      'hold',
    ])
  })

  it('follows the performance order when the effects library has the effects', () => {
    const extra = ['zoom-pulse', 'shake', 'invert', 'glitch'].map((id) =>
      catalogEntry({
        kind: 'effect',
        id,
        name: id,
        category: 'Test',
        params: [{ key: 'amount', label: 'A', type: 'number', default: 1, min: 0, max: 1 }],
        fragmentShader: '',
      }),
    )
    const layout = defaultLayout(makeProject(), [...catalog, ...extra])
    expect(labels(layout.effects)).toEqual([
      'Strobe',
      'RGB split',
      'zoom-pulse',
      'Glow',
      'shake',
      'invert',
      'Blur',
      'Mono',
      'Freeze',
    ])
  })

  it('opens more banks when there are more than ten clips', () => {
    const project = makeProject()
    for (let i = 0; i < 9; i++)
      project.assets['extra' + i] = asset('extra' + i, 'image', 'Extra ' + i + '.png', undefined, 5)
    const layout = defaultLayout(project, catalog)
    expect(layout.clipBanks).toHaveLength(2)
    expect(layout.clipBanks[1]?.filter(Boolean)).toHaveLength(5)
  })

  it('leaves out derived media such as masks and stems', () => {
    const project = makeProject()
    project.assets.mask = {
      ...asset('mask', 'video', 'mask.webm', 10),
      origin: { type: 'derived', parentAssetId: 'city' },
    }
    const ids = defaultLayout(project, catalog)
      .clipBanks.flat()
      .map((p) => p?.id)
    expect(ids).not.toContain('clip:mask')
  })
})

describe('reconcileLayout', () => {
  it('empties pads whose media is gone and adds new media to free slots, unless the user removed it', () => {
    const project = makeProject()
    const layout = defaultLayout(project, catalog)
    delete project.assets.singer
    project.assets.crowd = asset('crowd', 'video', 'Crowd.mp4', 5, 6)
    project.assets.rain = asset('rain', 'video', 'Rain.mp4', 5, 7)
    const saved: VjLayout = { ...layout, dismissed: ['clip:rain'] }
    const next = reconcileLayout(saved, project, catalog)
    expect(labels(next.clipBanks[0]).slice(0, 7)).toEqual([
      'Night city',
      'Crowd',
      'Sunset',
      'Spectrum bars',
      'Waveform line',
      'Particles',
      null,
    ])
  })

  it('drops effect pads whose plugin is not registered', () => {
    const project = makeProject()
    const layout = defaultLayout(project, catalog)
    const next = reconcileLayout(
      layout,
      project,
      catalog.filter((e) => e.id !== 'glow'),
    )
    expect(labels(next.effects)).not.toContain('Glow')
    expect(next.effects).toHaveLength(9)
  })
})

describe('saved layouts', () => {
  it('round-trips through the project and rejects malformed data', () => {
    const project = makeProject()
    const layout = defaultLayout(project, catalog)
    const custom: VjLayout = { ...layout, looks: [...layout.looks].reverse() }
    expect(parseLayout(JSON.parse(JSON.stringify(custom)))).toEqual(custom)
    expect(parseLayout({ ...custom, version: 2 })).toBeNull()
    expect(
      parseLayout({
        version: 1,
        clipBanks: [[{ id: 'x', label: 'x', action: { kind: 'nope' } }]],
        effects: [],
        looks: [],
      }),
    ).toBeNull()
    project.extensions = { [LAYOUT_EXTENSION_KEY]: JSON.parse(JSON.stringify(custom)) }
    expect(labels(layoutForProject(project, catalog).looks)[0]).toBe('Ember')
    project.extensions = { [LAYOUT_EXTENSION_KEY]: 'garbage' }
    expect(labels(layoutForProject(project, catalog).looks)[0]).toBe('Original')
  })
})

describe('effectTarget', () => {
  const custom = (params: PluginCatalogEntry['params']): PluginCatalogEntry[] => [
    catalogEntry({
      kind: 'effect',
      id: 'custom',
      name: 'Custom',
      category: 'Test',
      params,
      fragmentShader: '',
    }),
  ]

  it('uses performance ranges for built-ins, a strength-like param for others, and opacity as the fallback', () => {
    expect(effectTarget({ type: 'effect', effectId: 'blur' }, catalog)).toEqual({
      kind: 'param',
      key: 'radius',
      off: 0,
      on: 24,
    })
    expect(
      effectTarget(
        { type: 'effect', effectId: 'custom' },
        custom([{ key: 'strength', label: 'S', type: 'number', default: 0.4, min: 0, max: 1 }]),
      ),
    ).toEqual({ kind: 'param', key: 'strength', off: 0, on: 0.4 })
    expect(
      effectTarget(
        { type: 'effect', effectId: 'custom' },
        custom([{ key: 'mode', label: 'M', type: 'number', default: 0, min: 0, max: 3, animatable: false }]),
      ),
    ).toEqual({ kind: 'opacity' })
    expect(
      effectTarget({ type: 'effect', effectId: 'glow', amountParam: 'radius', range: [2, 50] }, catalog),
    ).toEqual({ kind: 'param', key: 'radius', off: 2, on: 50 })
  })
})
