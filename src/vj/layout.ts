/**
 * Pad layouts: sensible defaults from the project's media and the plugin catalog, reconciling a saved layout with
 * the current project (media added or removed), validation of saved layouts, and how an effect pad's amount maps to
 * plugin parameters.
 */
import { z } from 'zod'
import type { PluginCatalogEntry } from '../engine/types.ts'
import type { Asset, Project } from '../model/types.ts'
import { availableLooks, type VjLookPreset } from './looks.ts'
import { ROW_SIZE, type FxSpec, type Pad, type PadRow, type PadSnapshot, type VjLayout } from './types.ts'

/** Key of the saved layout in project.extensions. */
export const LAYOUT_EXTENSION_KEY = 'vj'

function isPerformable(asset: Asset): boolean {
  return (
    (asset.kind === 'video' || asset.kind === 'image') &&
    asset.origin.type !== 'derived' &&
    asset.origin.type !== 'stem'
  )
}

function labelFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return base.replace(/[_-]+/g, ' ').trim() || name
}

export function clipPadForAsset(asset: Asset): Pad {
  return {
    id: `clip:${asset.id}`,
    label: labelFromName(asset.name),
    action: {
      kind: 'clip',
      source: { type: 'asset', assetId: asset.id },
      trigger: 'latch',
      playback: 'resume',
    },
  }
}

export function clipPadForGenerator(entry: PluginCatalogEntry): Pad {
  return {
    id: `clip:gen:${entry.id}`,
    label: entry.name,
    action: {
      kind: 'clip',
      source: { type: 'generator', generatorId: entry.id },
      trigger: 'latch',
      playback: 'resume',
    },
  }
}

function performableAssets(project: Project): Asset[] {
  return Object.values(project.assets)
    .filter(isPerformable)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

function fxPad(
  id: string,
  label: string,
  fx: FxSpec,
  trigger: 'one-shot' | 'hold' | 'toggle',
  amount = 1,
  decay = 0.3,
): Pad {
  return { id, label, action: { kind: 'effect', fx, trigger, decay, amount, velocity: true } }
}

/** VJ staples built from solids and color adjustments, so they work with any plugin set. */
const STROBE = fxPad('fx:strobe', 'Strobe', { type: 'flash', color: '#ffffff', strobe: 4 }, 'hold', 0.9)
const FLASH = fxPad('fx:flash', 'Flash', { type: 'flash', color: '#ffffff' }, 'one-shot', 0.85, 0.35)
const MONO = fxPad(
  'fx:mono',
  'Mono',
  { type: 'adjust', adjustments: { saturation: -1, contrast: 0.25 } },
  'hold',
)
const HUE = fxPad('fx:hue', 'Hue shift', { type: 'adjust', adjustments: { hue: 0.5 } }, 'hold')
const FREEZE = fxPad('fx:freeze', 'Freeze', { type: 'freeze' }, 'hold')

/** The effects row, by catalog id or built-in pad; missing entries are filled from FILL, then the rest of the catalog. */
const ORDER: (string | Pad)[] = [
  STROBE,
  'rgb-split',
  'zoom-pulse',
  'glow',
  'shake',
  'invert',
  'blur',
  MONO,
  FREEZE,
]
const FILL: (string | Pad)[] = ['glitch', FLASH, HUE, 'vignette', 'film-grain']
/** Catalog effects the built-in pads already cover. */
const COVERED = new Set(['strobe', 'flash', 'freeze'])
const ONE_SHOT_WORDS = ['rgb', 'glitch', 'shake', 'zoom']
const TOGGLE_IDS = new Set(['vignette', 'film-grain'])

function effectPadFor(entry: PluginCatalogEntry): Pad {
  const oneShot = ONE_SHOT_WORDS.some((w) => entry.id.includes(w))
  const trigger = TOGGLE_IDS.has(entry.id) ? 'toggle' : oneShot ? 'one-shot' : 'hold'
  return fxPad(`fx:effect:${entry.id}`, entry.name, { type: 'effect', effectId: entry.id }, trigger, 1, 0.35)
}

function defaultEffectPads(catalog: readonly PluginCatalogEntry[]): Pad[] {
  const effects = catalog.filter((e) => e.kind === 'effect' && !COVERED.has(e.id))
  const byId = new Map(effects.map((e) => [e.id, e]))
  const used = new Set<string>()
  const take = (item: string | Pad): Pad[] => {
    const key = typeof item === 'string' ? item : item.id
    if (used.has(key)) return []
    if (typeof item !== 'string') {
      used.add(key)
      return [item]
    }
    const entry = byId.get(item)
    if (!entry) return []
    used.add(key)
    return [effectPadFor(entry)]
  }
  const pads = ORDER.flatMap(take)
  for (const item of [...FILL, ...effects.map((e) => e.id)]) {
    if (pads.length >= ROW_SIZE.effects) break
    pads.push(...take(item))
  }
  // Keep the preferred order: fill-ins go where missing preferred pads would have been, before Freeze.
  const order = (p: Pad) => {
    const i = ORDER.findIndex((o) => (typeof o === 'string' ? `fx:effect:${o}` : o.id) === p.id)
    return i >= 0 ? i : ORDER.length - 1.5
  }
  return pads.slice(0, ROW_SIZE.effects).sort((a, b) => order(a) - order(b))
}

function lookPads(looks: readonly VjLookPreset[]): Pad[] {
  const original: Pad = { id: 'look:original', label: 'Original', action: { kind: 'look', look: null } }
  const rest = looks.map<Pad>((l) => ({
    id: `look:${l.id}`,
    label: l.name,
    action: { kind: 'look', look: { adjustments: l.adjustments, effects: l.effects } },
  }))
  return [original, ...rest].slice(0, ROW_SIZE.looks)
}

function padRow(pads: readonly (Pad | null)[], size: number): (Pad | null)[] {
  return Array.from({ length: size }, (_, i) => pads[i] ?? null)
}

function banksOf(pads: Pad[]): (Pad | null)[][] {
  const banks: (Pad | null)[][] = []
  for (let i = 0; i < Math.max(1, pads.length); i += ROW_SIZE.clips)
    banks.push(padRow(pads.slice(i, i + ROW_SIZE.clips), ROW_SIZE.clips))
  return banks
}

/**
 * The layout a project starts with: its clips and images (oldest first), then the catalog's visualizers, in banks
 * of ten; performance effects; and "Original" plus the looks.
 */
export function defaultLayout(
  project: Project,
  catalog: readonly PluginCatalogEntry[],
  looks: readonly VjLookPreset[] = availableLooks(),
): VjLayout {
  const clips = [
    ...performableAssets(project).map(clipPadForAsset),
    ...catalog.filter((e) => e.kind === 'generator').map(clipPadForGenerator),
  ]
  return {
    version: 1,
    clipBanks: banksOf(clips),
    effects: padRow(defaultEffectPads(catalog), ROW_SIZE.effects),
    looks: padRow(lookPads(looks), ROW_SIZE.looks),
  }
}

function padUsable(pad: Pad, project: Project, catalog: readonly PluginCatalogEntry[]): boolean {
  const action = pad.action
  if (action.kind === 'clip') {
    const source = action.source
    if (source?.type === 'asset') return Boolean(project.assets[source.assetId])
    if (source?.type === 'generator') return catalog.some((e) => e.id === source.generatorId)
    return true
  }
  if (action.kind === 'effect' && action.fx.type === 'effect') {
    const id = action.fx.effectId
    return catalog.some((e) => e.id === id && e.kind === 'effect')
  }
  return true
}

/**
 * Fits a saved layout to the project as it is now: pads whose media or plugin is gone are emptied, and media that
 * is on no pad (and was not removed by the user) fills empty clip slots, adding a bank when needed.
 */
export function reconcileLayout(
  layout: VjLayout,
  project: Project,
  catalog: readonly PluginCatalogEntry[],
): VjLayout {
  const keep = (pad: Pad | null) => (pad && padUsable(pad, project, catalog) ? pad : null)
  const banks = layout.clipBanks.map((bank) => padRow(bank.map(keep), ROW_SIZE.clips))
  if (banks.length === 0) banks.push(padRow([], ROW_SIZE.clips))
  const present = new Set(banks.flat().map((p) => p?.id))
  const dismissed = new Set(layout.dismissed ?? [])
  for (const asset of performableAssets(project)) {
    const pad = clipPadForAsset(asset)
    if (present.has(pad.id) || dismissed.has(pad.id)) continue
    let placed = false
    for (const bank of banks) {
      const slot = bank.indexOf(null)
      if (slot >= 0) {
        bank[slot] = pad
        placed = true
        break
      }
    }
    if (!placed) banks.push(padRow([pad], ROW_SIZE.clips))
    present.add(pad.id)
  }
  while (banks.length > 1 && (banks[banks.length - 1] as (Pad | null)[]).every((p) => p === null)) banks.pop()
  return {
    version: 1,
    clipBanks: banks,
    effects: padRow(layout.effects.map(keep), ROW_SIZE.effects),
    looks: padRow(layout.looks.map(keep), ROW_SIZE.looks),
    ...(layout.dismissed?.length ? { dismissed: layout.dismissed } : {}),
  }
}

/** Every pad with its row and index. Clip pads of all banks are included, numbered within their bank. */
export function layoutPads(layout: VjLayout): PadSnapshot[] {
  const out: PadSnapshot[] = []
  layout.clipBanks.forEach((bank) =>
    bank.forEach((pad, index) => {
      if (pad) out.push({ ...pad, row: 'clips', index })
    }),
  )
  layout.effects.forEach((pad, index) => {
    if (pad) out.push({ ...pad, row: 'effects', index })
  })
  layout.looks.forEach((pad, index) => {
    if (pad) out.push({ ...pad, row: 'looks', index })
  })
  return out
}

export function padAt(layout: VjLayout, row: PadRow, index: number, bank = 0): Pad | null {
  if (row === 'clips') return layout.clipBanks[bank]?.[index] ?? null
  return (row === 'effects' ? layout.effects : layout.looks)[index] ?? null
}

// ---------------------------------------------------------------------------------------------------------------
// Effect amounts

/** How an effect pad's amount reaches the picture. */
export type FxTarget = { kind: 'param'; key: string; off: number; on: number } | { kind: 'opacity' }

/** Ranges that read well when performing, for the built-in effects. */
const KNOWN_AMOUNT: Record<string, [string, number, number]> = {
  glow: ['intensity', 0, 2],
  blur: ['radius', 0, 24],
  'rgb-split': ['amount', 0, 28],
  vignette: ['amount', 0, 0.85],
  'film-grain': ['amount', 0, 0.45],
}
const AMOUNT_KEYS = ['amount', 'intensity', 'strength', 'mix', 'radius', 'size']

export function effectTarget(
  fx: Extract<FxSpec, { type: 'effect' }>,
  catalog: readonly PluginCatalogEntry[],
): FxTarget {
  const entry = catalog.find((e) => e.id === fx.effectId)
  const numeric = (entry?.params ?? []).filter(
    (p): p is Extract<typeof p, { type: 'number' }> => p.type === 'number' && p.animatable !== false,
  )
  const named = (key: string) => numeric.find((p) => p.key === key)
  if (fx.amountParam) {
    const spec = named(fx.amountParam)
    if (spec) {
      const [off, on] = fx.range ?? [spec.min, spec.default > spec.min ? spec.default : spec.max]
      return { kind: 'param', key: spec.key, off, on }
    }
  }
  const known = KNOWN_AMOUNT[fx.effectId]
  if (known && named(known[0])) return { kind: 'param', key: known[0], off: known[1], on: known[2] }
  for (const key of AMOUNT_KEYS) {
    const spec = named(key)
    if (spec)
      return { kind: 'param', key, off: spec.min, on: spec.default > spec.min ? spec.default : spec.max }
  }
  return { kind: 'opacity' }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation of saved layouts

const paramValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.number())])
const params = z.record(z.string(), paramValue)
const adjustments = z.record(z.string(), z.number())
const clipSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('asset'), assetId: z.string() }),
  z.object({ type: z.literal('generator'), generatorId: z.string(), params: params.optional() }),
  z.object({ type: z.literal('solid'), color: z.string() }),
])
const fxSpec = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('effect'),
    effectId: z.string(),
    params: params.optional(),
    amountParam: z.string().optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
  }),
  z.object({ type: z.literal('adjust'), adjustments }),
  z.object({ type: z.literal('flash'), color: z.string(), strobe: z.number().positive().optional() }),
  z.object({ type: z.literal('freeze') }),
])
const action = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clip'),
    source: clipSource.nullable(),
    trigger: z.enum(['latch', 'momentary']),
    playback: z.enum(['resume', 'restart', 'sync']),
  }),
  z.object({
    kind: z.literal('effect'),
    fx: fxSpec,
    trigger: z.enum(['one-shot', 'hold', 'toggle', 'knob']),
    decay: z.number().positive(),
    amount: z.number().min(0).max(1),
    velocity: z.boolean(),
  }),
  z.object({
    kind: z.literal('look'),
    look: z
      .object({
        adjustments: adjustments.optional(),
        effects: z.array(z.object({ effectId: z.string(), params: params.optional() })).optional(),
      })
      .nullable(),
  }),
])
const pad = z.object({ id: z.string().min(1), label: z.string(), action })
const layoutSchema = z.object({
  version: z.literal(1),
  clipBanks: z.array(z.array(pad.nullable())),
  effects: z.array(pad.nullable()),
  looks: z.array(pad.nullable()),
  dismissed: z.array(z.string()).optional(),
})

/** A saved layout, or null when the data is missing or not a valid layout. */
export function parseLayout(value: unknown): VjLayout | null {
  const result = layoutSchema.safeParse(value)
  return result.success ? (result.data as VjLayout) : null
}

/** The project's layout: its saved one fitted to the current media, or the default. */
export function layoutForProject(project: Project, catalog: readonly PluginCatalogEntry[]): VjLayout {
  const saved = parseLayout(project.extensions?.[LAYOUT_EXTENSION_KEY])
  return saved ? reconcileLayout(saved, project, catalog) : defaultLayout(project, catalog)
}
