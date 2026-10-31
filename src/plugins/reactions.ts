/**
 * Music reactions: one-choice audio reactivity for clip properties and plugin params ("Pulse with kick" at 60%)
 * instead of a modulation editor. A reaction writes an ordinary AudioModulation, so the renderer, the inspector's
 * advanced view and saved projects need nothing new. Each reaction lists the features it can listen to, best first:
 * a separated stem when there is one, else a frequency band, onsets or the beat grid of the full mix. The active
 * reaction is recognized from the mapping itself, so a mapping edited by hand reads as custom.
 */
import { pluginRegistry } from '../engine/registry.ts'
import type { ParamSpec, PluginRegistry } from '../engine/types.ts'
import type { EditCommand, PropertyPath } from '../model/commands.ts'
import type { ProjectEditor } from '../model/editor.ts'
import type {
  Animatable,
  AudioAnalysis,
  AudioFeatureSource,
  AudioFeatures,
  AudioModulation,
  Clip,
  ColorAdjustmentKey,
  Id,
  Project,
  StemName,
} from '../model/types.ts'

export type ReactionId = 'kick' | 'snare' | 'hats' | 'bass' | 'vocals' | 'loudness' | 'beat' | 'downbeat'

/** A feature a reaction can listen to: of a stem, of the full mix, or the song's beat grid. */
export type Listen =
  | { feature: 'loudness' | 'onset'; stem?: StemName }
  | { feature: 'band'; hz: number; stem?: StemName }
  | { feature: 'beat' | 'downbeat' }

export interface Reaction {
  id: ReactionId
  /** Picker label, e.g. 'Pulse with kick'. */
  name: string
  /** Short label for "Reacts to: Kick · 60%". */
  label: string
  description: string
  /** What it listens to, best first. The first one the song's analysis has is used. */
  listen: Listen[]
  /** Smoothing of the mapping (0 = raw); for pulses it lengthens the decay. Unique per reaction. */
  smoothing: number
  defaultAmount: number
  /** The stem that makes this reaction precise, so pickers can suggest separating stems. */
  bestWithStem?: StemName
}

export const REACTIONS: Reaction[] = [
  {
    id: 'kick',
    name: 'Pulse with kick',
    label: 'Kick',
    description: 'A punchy pulse on every kick drum.',
    listen: [
      { feature: 'band', hz: 100, stem: 'drums' },
      { feature: 'band', hz: 45 },
    ],
    smoothing: 0.05,
    defaultAmount: 0.4,
    bestWithStem: 'drums',
  },
  {
    id: 'snare',
    name: 'Hit on snare',
    label: 'Snare',
    description: 'A sharp hit on snares and claps.',
    listen: [{ feature: 'band', hz: 3000, stem: 'drums' }, { feature: 'onset' }],
    smoothing: 0.1,
    defaultAmount: 0.4,
    bestWithStem: 'drums',
  },
  {
    id: 'hats',
    name: 'Sparkle on hi-hats',
    label: 'Hi-hats',
    description: 'Quick flickers on hi-hats and cymbals.',
    listen: [
      { feature: 'band', hz: 8000, stem: 'drums' },
      { feature: 'band', hz: 8000 },
    ],
    smoothing: 0,
    defaultAmount: 0.3,
    bestWithStem: 'drums',
  },
  {
    id: 'bass',
    name: 'Ride the bass',
    label: 'Bass',
    description: 'Rises and falls with the bassline.',
    listen: [
      { feature: 'loudness', stem: 'bass' },
      { feature: 'band', hz: 120 },
    ],
    smoothing: 0.35,
    defaultAmount: 0.35,
    bestWithStem: 'bass',
  },
  {
    id: 'vocals',
    name: 'Breathe with vocals',
    label: 'Vocals',
    description: 'Swells gently while the singer sings.',
    listen: [
      { feature: 'loudness', stem: 'vocals' },
      { feature: 'band', hz: 1000 },
    ],
    smoothing: 0.6,
    defaultAmount: 0.3,
    bestWithStem: 'vocals',
  },
  {
    id: 'loudness',
    name: 'Follow loudness',
    label: 'Loudness',
    description: 'Bigger in loud parts, calmer in quiet ones.',
    listen: [{ feature: 'loudness' }],
    smoothing: 0.4,
    defaultAmount: 0.35,
  },
  {
    id: 'beat',
    name: 'Flash on beat',
    label: 'Beat',
    description: 'A short flash on every beat.',
    listen: [{ feature: 'beat' }, { feature: 'onset' }],
    smoothing: 0,
    defaultAmount: 0.5,
  },
  {
    id: 'downbeat',
    name: 'Swell on downbeat',
    label: 'Downbeat',
    description: 'A slow swell at the start of every bar.',
    listen: [{ feature: 'downbeat' }, { feature: 'beat' }],
    smoothing: 0.6,
    defaultAmount: 0.4,
  },
]

export function reaction(id: string): Reaction | undefined {
  return REACTIONS.find((r) => r.id === id)
}

// ---------------------------------------------------------------------------------------------------------------
// Listening: which feature source a reaction uses for a project's song

/** Band edges of the song analysis (src/analysis BAND_EDGES_HZ), for projects whose song is not analyzed yet. */
export const DEFAULT_BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 4000, 6000, 11025]

function songAnalysis(project: Project): AudioAnalysis | undefined {
  return project.songAssetId ? project.analysis.audio[project.songAssetId] : undefined
}

/** Index of the band whose (log) center is nearest to `hz`. */
function bandNear(hz: number, features: AudioFeatures | undefined): number {
  const edges = features?.bandEdgesHz?.length ? features.bandEdgesHz : DEFAULT_BAND_EDGES_HZ
  const count = features?.bands[0]?.length ?? edges.length - 1
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < count && i + 1 < edges.length; i++) {
    const center = Math.sqrt(Math.max(1, edges[i] as number) * (edges[i + 1] as number))
    const distance = Math.abs(Math.log(center / hz))
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

function featuresOf(analysis: AudioAnalysis | undefined, stem?: StemName): AudioFeatures | undefined {
  return stem ? analysis?.stemFeatures?.[stem] : analysis?.features
}

function hasData(listen: Listen, analysis: AudioAnalysis | undefined): boolean {
  switch (listen.feature) {
    case 'beat':
      return (analysis?.beats?.length ?? 0) > 0
    case 'downbeat':
      return (analysis?.downbeats?.length ?? 0) > 0
    case 'band':
      return (featuresOf(analysis, listen.stem)?.bands.length ?? 0) > 0
    default:
      return !!featuresOf(analysis, listen.stem)
  }
}

function sourceOf(listen: Listen, analysis: AudioAnalysis | undefined): AudioFeatureSource {
  const stem = 'stem' in listen && listen.stem ? { stem: listen.stem } : {}
  switch (listen.feature) {
    case 'beat':
    case 'downbeat':
      return { kind: listen.feature }
    case 'band':
      return { kind: 'band', band: bandNear(listen.hz, featuresOf(analysis, listen.stem)), ...stem }
    default:
      return { kind: listen.feature, ...stem }
  }
}

/**
 * What a reaction listens to in this project: the first option the song's analysis has. Before the song is analyzed,
 * the first full-mix option, which starts working as soon as analysis arrives.
 */
export function chooseListen(project: Project, r: Reaction): Listen {
  const analysis = songAnalysis(project)
  const listen =
    r.listen.find((l) => hasData(l, analysis)) ??
    r.listen.find((l) => !('stem' in l && l.stem)) ??
    r.listen[0]
  if (!listen) throw new Error(`Reaction "${r.id}" listens to nothing`)
  return listen
}

const STEM_LABELS: Record<StemName, string> = {
  vocals: 'Vocals stem',
  drums: 'Drums stem',
  bass: 'Bass stem',
  other: 'Other instruments stem',
}

function bandLabel(hz: number): string {
  if (hz < 80) return 'Sub bass'
  if (hz < 300) return 'Bass frequencies'
  if (hz < 2000) return 'Mid frequencies'
  if (hz < 5000) return 'Upper mids'
  return 'High frequencies'
}

/** Plain-language name of what a reaction listens to, e.g. 'Drums stem' or 'Sub bass'. */
export function listenLabel(listen: Listen): string {
  if ('stem' in listen && listen.stem) return STEM_LABELS[listen.stem]
  switch (listen.feature) {
    case 'beat':
      return 'Beat grid'
    case 'downbeat':
      return 'Bar grid'
    case 'band':
      return bandLabel(listen.hz)
    case 'loudness':
      return 'Loudness'
    case 'onset':
      return 'Every hit'
  }
}

export interface ReactionAvailability {
  reaction: Reaction
  listen: Listen
  /** e.g. 'Drums stem', or 'Sub bass' when stems are not separated. */
  listensTo: string
  /** Separating stems would make this reaction follow its instrument precisely. */
  betterWithStems: boolean
  /** The song has the data this reaction uses (false until the song is analyzed). */
  ready: boolean
}

/** Every reaction with what it would listen to in this project, for the picker. */
export function availableReactions(project: Project): ReactionAvailability[] {
  const analysis = songAnalysis(project)
  return REACTIONS.map((r) => {
    const listen = chooseListen(project, r)
    return {
      reaction: r,
      listen,
      listensTo: listenLabel(listen),
      betterWithStems: !!r.bestWithStem && !('stem' in listen && listen.stem),
      ready: hasData(listen, analysis),
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Targets: what reacts

/** Clip properties that can react, besides plugin params. 'scale' drives scaleX and scaleY together. */
export type ReactiveClipProperty =
  'scale' | 'opacity' | 'rotation' | 'x' | 'y' | `adjustments.${ColorAdjustmentKey}`

export type ReactionTarget =
  | { clipId: Id; property: ReactiveClipProperty }
  /** A param of the clip's generator (visualizers and shader scenes). */
  | { clipId: Id; param: string }
  /** A param of one of the clip's effects. */
  | { clipId: Id; effectInstanceId: Id; param: string }

/**
 * How far a full Amount moves a clip property at the feature's peak: a strong pulse that still keeps the picture
 * recognizable. Plugin params move across their whole range.
 */
const PROPERTY_SPAN: Record<string, number> = { scale: 0.5, opacity: 1, rotation: 30, x: 0.25, y: 0.25 }
const ADJUSTMENT_SPAN = 1

interface Resolved {
  clip: Clip
  paths: PropertyPath[]
  /** Change a full Amount makes at the feature's peak. */
  span: number
  /** Value used when the property or param is not written out yet. */
  fallback: number
}

function resolveTarget(project: Project, target: ReactionTarget, registry: PluginRegistry): Resolved | null {
  const clip = project.clips[target.clipId]
  if (!clip || clip.type === 'audio') return null
  if ('property' in target) {
    const p = target.property
    if (p.startsWith('adjustments.'))
      return {
        clip,
        paths: [['adjustments', p.slice('adjustments.'.length)]],
        span: ADJUSTMENT_SPAN,
        fallback: 0,
      }
    const paths: Record<string, PropertyPath[]> = {
      scale: [
        ['transform', 'scaleX'],
        ['transform', 'scaleY'],
      ],
      opacity: [['opacity']],
      rotation: [['transform', 'rotation']],
      x: [['transform', 'x']],
      y: [['transform', 'y']],
    }
    const list = paths[p]
    const span = PROPERTY_SPAN[p]
    if (!list || span === undefined) return null
    return {
      clip,
      paths: list,
      span,
      fallback: p === 'scale' || p === 'opacity' ? 1 : p === 'rotation' ? 0 : 0.5,
    }
  }
  let spec: ParamSpec | undefined
  let path: PropertyPath
  if ('effectInstanceId' in target) {
    const index = clip.effects.findIndex((e) => e.id === target.effectInstanceId)
    const effect = clip.effects[index]
    if (!effect) return null
    spec = registry.get(effect.effectId)?.params.find((s) => s.key === target.param)
    path = ['effects', index, 'params', target.param]
  } else {
    if (clip.type !== 'generator') return null
    spec = registry.get(clip.generatorId)?.params.find((s) => s.key === target.param)
    path = ['params', target.param]
  }
  if (spec?.type !== 'number' || spec.modulatable === false) return null
  return { clip, paths: [path], span: spec.max - spec.min, fallback: spec.default }
}

/** Whether the target exists and accepts music reactions (numeric and modulatable). */
export function canReact(
  project: Project,
  target: ReactionTarget,
  registry: PluginRegistry = pluginRegistry,
): boolean {
  return resolveTarget(project, target, registry) !== null
}

function animAt(clip: Clip, path: PropertyPath): Animatable | undefined {
  let node: unknown = clip
  for (const key of path) node = (node as Record<string | number, unknown> | undefined)?.[key]
  return node && typeof node === 'object' && 'value' in node ? (node as Animatable) : undefined
}

/**
 * The params of a whole effect or generator that react when the user turns reactivity on for the plugin: the ones it
 * suggests itself (defaultModulation), else its first basic numeric param.
 */
export function pluginReactionTargets(
  project: Project,
  clipId: Id,
  effectInstanceId?: Id,
  registry: PluginRegistry = pluginRegistry,
): ReactionTarget[] {
  const clip = project.clips[clipId]
  if (!clip || clip.type === 'audio') return []
  const pluginId = effectInstanceId
    ? clip.effects.find((e) => e.id === effectInstanceId)?.effectId
    : clip.type === 'generator'
      ? clip.generatorId
      : undefined
  const def = pluginId ? registry.get(pluginId) : undefined
  if (!def) return []
  const target = (param: string): ReactionTarget =>
    effectInstanceId ? { clipId, effectInstanceId, param } : { clipId, param }
  const reactive = (s: ParamSpec) => s.type === 'number' && s.modulatable !== false
  const suggested = def.params.filter((s) => reactive(s) && def.defaultModulation?.[s.key]?.length)
  const params = suggested.length
    ? suggested
    : def.params.filter((s) => reactive(s) && !s.advanced).slice(0, 1)
  return params.map((s) => target(s.key))
}

// ---------------------------------------------------------------------------------------------------------------
// Applying and removing

function modulationFor(project: Project, r: Reaction, amount: number, span: number): AudioModulation {
  const source = sourceOf(chooseListen(project, r), songAnalysis(project))
  return { source, amount: round(clamp01(amount) * span), mode: 'add', smoothing: r.smoothing }
}

const round = (v: number) => Math.round(v * 1e5) / 1e5
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** clip.set commands that write `modulation` (or none) on the Animatable at each path, creating it when missing. */
function setModulation(
  resolved: Resolved,
  modulation: (current: Animatable | undefined) => AudioModulation[] | undefined,
): EditCommand[] {
  const { clip } = resolved
  return resolved.paths.map((path) => {
    const current = animAt(clip, path)
    const { modulation: _old, ...rest } = current ?? { value: resolved.fallback }
    const mods = modulation(current)
    const value: Animatable = mods?.length ? { ...rest, modulation: mods } : rest
    if (path[0] === 'adjustments' && !('adjustments' in clip && clip.adjustments))
      return {
        type: 'clip.set',
        clipId: clip.id,
        path: ['adjustments'],
        value: { [path[1] as string]: value },
      }
    return { type: 'clip.set', clipId: clip.id, path, value }
  })
}

function unlocked(project: Project, clip: Clip): boolean {
  return !project.tracks.find((t) => t.id === clip.trackId)?.locked
}

export interface ReactionOptions {
  registry?: PluginRegistry
}

/**
 * Commands that make the targets react to the music with one reaction, replacing whatever mapping they had. Targets
 * that cannot react, and clips on locked tracks, are skipped.
 */
export function reactionCommands(
  project: Project,
  targets: readonly ReactionTarget[],
  reactionId: ReactionId,
  amount?: number,
  options: ReactionOptions = {},
): EditCommand[] {
  const r = reaction(reactionId)
  if (!r) throw new Error(`Unknown reaction "${reactionId}"`)
  const registry = options.registry ?? pluginRegistry
  const commands: EditCommand[] = []
  for (const target of targets) {
    const resolved = resolveTarget(project, target, registry)
    if (!resolved || !unlocked(project, resolved.clip)) continue
    const mod = modulationFor(project, r, amount ?? r.defaultAmount, resolved.span)
    commands.push(...setModulation(resolved, () => [mod]))
  }
  return commands
}

/** Commands that stop the targets reacting to the music (every mapping on them is removed). */
export function removeReactionCommands(
  project: Project,
  targets: readonly ReactionTarget[],
  options: ReactionOptions = {},
): EditCommand[] {
  const registry = options.registry ?? pluginRegistry
  const commands: EditCommand[] = []
  for (const target of targets) {
    const resolved = resolveTarget(project, target, registry)
    if (!resolved || !unlocked(project, resolved.clip)) continue
    if (resolved.paths.every((path) => !animAt(resolved.clip, path)?.modulation?.length)) continue
    commands.push(...setModulation(resolved, () => undefined))
  }
  return commands
}

/**
 * Commands that change only the amount of the targets' current reactions, keeping what they listen to and their
 * smoothing (also for mappings recognized loosely, such as a plugin's default). Custom mappings are left alone.
 */
export function reactionAmountCommands(
  project: Project,
  targets: readonly ReactionTarget[],
  amount: number,
  options: ReactionOptions = {},
): EditCommand[] {
  const registry = options.registry ?? pluginRegistry
  const commands: EditCommand[] = []
  for (const target of targets) {
    const resolved = resolveTarget(project, target, registry)
    const active = describeReaction(project, target, options)
    if (!resolved || active?.kind !== 'reaction' || !unlocked(project, resolved.clip)) continue
    const value = round(clamp01(amount) * resolved.span)
    commands.push(
      ...setModulation(resolved, (current) => current?.modulation?.map((m) => ({ ...m, amount: value }))),
    )
  }
  return commands
}

/** Makes the targets react with one reaction, as one undo step. Pass `coalesceKey` while dragging an Amount slider. */
export function applyReaction(
  editor: ProjectEditor,
  targets: readonly ReactionTarget[],
  reactionId: ReactionId,
  options: ReactionOptions & { amount?: number } = {},
): void {
  const commands = reactionCommands(editor.getProject(), targets, reactionId, options.amount, options)
  if (commands.length) editor.dispatch(commands, { label: `React to music: ${reaction(reactionId)?.name}` })
}

/** Changes the amount of the targets' reactions. One undo step per gesture when `coalesceKey` is given. */
export function setReactionAmount(
  editor: ProjectEditor,
  targets: readonly ReactionTarget[],
  amount: number,
  options: ReactionOptions & { coalesceKey?: string } = {},
): void {
  const commands = reactionAmountCommands(editor.getProject(), targets, amount, options)
  if (commands.length)
    editor.dispatch(commands, {
      label: 'Reaction amount',
      ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    })
}

/** Stops the targets reacting to the music, as one undo step. */
export function removeReaction(
  editor: ProjectEditor,
  targets: readonly ReactionTarget[],
  options: ReactionOptions = {},
): void {
  const commands = removeReactionCommands(editor.getProject(), targets, options)
  if (commands.length) editor.dispatch(commands, { label: 'Stop reacting to music' })
}

// ---------------------------------------------------------------------------------------------------------------
// Recognizing the active reaction

export type ActiveReaction =
  | {
      kind: 'reaction'
      reaction: Reaction
      /** 0..1, shown as a percentage. */
      amount: number
      /** What it listens to now, e.g. 'Drums stem' or 'Sub bass'. */
      listensTo: string
      /** A better source is available now (stems were separated after the reaction was chosen). */
      canUpgrade: boolean
      /**
       * False when the mapping matches the reaction's source but not its exact settings (for example a plugin's
       * default mapping); changing the amount keeps those settings.
       */
      exact: boolean
      /** e.g. 'Kick · 60%'. */
      summary: string
      modulation: AudioModulation[]
    }
  | { kind: 'custom'; summary: string; modulation: AudioModulation[] }

const sameSource = (a: AudioFeatureSource, b: AudioFeatureSource) =>
  a.kind === b.kind &&
  ('band' in a ? a.band : undefined) === ('band' in b ? b.band : undefined) &&
  ('stem' in a ? a.stem : undefined) === ('stem' in b ? b.stem : undefined)

/** The reaction a single mapping belongs to, with the option it listens through. */
function matchMapping(
  project: Project,
  mod: AudioModulation,
): { reaction: Reaction; listen: Listen; exact: boolean } | null {
  if (mod.mode !== 'add' || mod.audioAssetId) return null
  const analysis = songAnalysis(project)
  for (const r of REACTIONS) {
    if (mod.smoothing !== r.smoothing) continue
    const listen = r.listen.find((l) => sameSource(sourceOf(l, analysis), mod.source))
    if (listen) return { reaction: r, listen, exact: true }
  }
  // Mappings made elsewhere (plugin defaults, the director) count when they use a reaction's preferred source.
  for (const r of REACTIONS) {
    const listen = r.listen[0]
    if (listen && sameSource(sourceOf(listen, analysis), mod.source))
      return { reaction: r, listen, exact: false }
  }
  return null
}

/** The reaction active on a target, a custom mapping, or null when it does not react to the music. */
export function describeReaction(
  project: Project,
  target: ReactionTarget,
  options: ReactionOptions = {},
): ActiveReaction | null {
  const resolved = resolveTarget(project, target, options.registry ?? pluginRegistry)
  if (!resolved) return null
  const lists = resolved.paths.map((path) => animAt(resolved.clip, path)?.modulation ?? [])
  const first = lists[0] ?? []
  if (first.length === 0 && lists.every((l) => l.length === 0)) return null
  const custom = { kind: 'custom' as const, summary: 'Custom', modulation: first }
  const same = lists.every((l) => JSON.stringify(l) === JSON.stringify(first))
  const mod = first[0]
  if (!same || first.length !== 1 || !mod) return custom
  const match = matchMapping(project, mod)
  if (!match) return custom
  const amount = clamp01(mod.amount / resolved.span)
  const best = chooseListen(project, match.reaction)
  return {
    kind: 'reaction',
    reaction: match.reaction,
    amount,
    listensTo: listenLabel(match.listen),
    canUpgrade: match.exact && best !== match.listen && hasData(best, songAnalysis(project)),
    exact: match.exact,
    summary: `${match.reaction.label} · ${Math.round(amount * 100)}%`,
    modulation: first,
  }
}

/** Every target in the project that can react, for project-wide passes. */
export function reactionTargetsOf(
  project: Project,
  registry: PluginRegistry = pluginRegistry,
): ReactionTarget[] {
  const out: ReactionTarget[] = []
  const properties: ReactiveClipProperty[] = ['scale', 'opacity', 'rotation', 'x', 'y']
  for (const clip of Object.values(project.clips)) {
    if (clip.type === 'audio') continue
    for (const property of properties) out.push({ clipId: clip.id, property })
    for (const key of Object.keys(('adjustments' in clip && clip.adjustments) || {}))
      out.push({ clipId: clip.id, property: `adjustments.${key as ColorAdjustmentKey}` })
    if (clip.type === 'generator')
      for (const spec of registry.get(clip.generatorId)?.params ?? [])
        out.push({ clipId: clip.id, param: spec.key })
    for (const effect of clip.effects)
      for (const spec of registry.get(effect.effectId)?.params ?? [])
        out.push({ clipId: clip.id, effectInstanceId: effect.id, param: spec.key })
  }
  return out.filter((t) => resolveTarget(project, t, registry))
}

/**
 * Commands that move reactions to a better source that became available, such as the drums stem for "Pulse with
 * kick" after stem separation, keeping each reaction's amount. Dispatch them after stems or analysis arrive.
 */
export function upgradeReactionCommands(project: Project, options: ReactionOptions = {}): EditCommand[] {
  const registry = options.registry ?? pluginRegistry
  const commands: EditCommand[] = []
  for (const target of reactionTargetsOf(project, registry)) {
    const active = describeReaction(project, target, options)
    if (active?.kind !== 'reaction' || !active.canUpgrade) continue
    commands.push(...reactionCommands(project, [target], active.reaction.id, active.amount, options))
  }
  return commands
}
