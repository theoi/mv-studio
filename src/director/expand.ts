/**
 * Turns a creative brief (from the rules or an LLM) into an exact EditPlan: beat- and bar-aligned shots, media
 * choices, generation prompts, transitions, effects, audio-reactive bindings, lyric text and a look. Anything the
 * brief leaves out or gets wrong (unknown ids, missing sections) falls back to the rules with a warning.
 */
import { newId } from '../model/factory.ts'
import type { LyricLine, Seconds } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { blankClipsNote, chooseClips, type ChooseSpan, type PoolItem } from '../vision/index.ts'
import type { BriefSection, CreativeBrief } from './brief.ts'
import { bestByTags, findItem, type CatalogItem, type LookPreset } from './catalog.ts'
import type { BrightnessRequest } from './contrast.ts'
import { NO_AI_SHOTS } from './notes.ts'
import {
  energyScale,
  musicEnd,
  type EnergyAt,
  type MediaItem,
  type PlannerInput,
  type SectionInfo,
  type VideoKind,
} from './inputs.ts'
import {
  editPlanSchema,
  PACES,
  shotsToGenerate,
  type AudioBinding,
  type EditPlan,
  type EffectSpec,
  type GenerateSource,
  type Motion,
  type Pace,
  type PlanLook,
  type PlanSection,
  type PlanShot,
  type PlanText,
  type ReactionSpec,
  type ShotSource,
  type TextStyleSpec,
  type TransitionSpec,
} from './plan.ts'
import {
  DEFAULT_CONCEPT,
  defaultSectionBrief,
  footageMood,
  isPeak,
  linesIn,
  moodFor,
  normalizedLabel,
  overlayPool,
  PARTICLES_ID,
  pickLook,
  roleOf,
  scenePool,
  sectionPrompts,
  sectionTier,
  visualIdea,
  visualizerPalette,
  type SectionTier,
} from './rules.ts'
import {
  beatGrid,
  beatsPerCut,
  createRng,
  cutTimes,
  cutTimesByLength,
  MIN_SHOT,
  phrasedCutTimes,
  sectionsFor,
  spans,
  wordTime,
  type BeatGrid,
} from './timing.ts'
import {
  emphasisStart,
  emphasisStyle,
  frameWidth,
  hookWords,
  layoutLine,
  lyricTypography,
  peakStyle,
  textWidth,
  titleStyle,
  type LyricTypography,
} from './typography.ts'

export type DirectorErrorReason =
  'no-song' | 'invalid-plan' | 'needs-confirmation' | 'no-plan' | 'no-provider'

export class DirectorError extends JobError {
  readonly reason: DirectorErrorReason
  constructor(reason: DirectorErrorReason, message: string, cause?: unknown) {
    super('invalid-input', message, { details: { director: reason }, cause })
    this.name = 'DirectorError'
    this.reason = reason
  }
}

type Visual = CreativeBrief['visual'] | 'solid'

const KIND_NAME: Record<VideoKind, string> = {
  lyric: 'Lyric video',
  visualizer: 'Visualizer',
  'beat-cut': 'Beat-cut video',
  ai: 'AI music video',
}

const IMAGE_MOTIONS: Motion[] = ['push-in', 'pan-right', 'pull-out', 'pan-left']

interface Ctx {
  input: PlannerInput
  brief: CreativeBrief
  grid: BeatGrid
  rng: () => number
  warnings: string[]
  look?: LookPreset
  visual: Visual
  concept: string
  promptStyle: string
  pending: PendingShot[]
  shotIndex: number
  generated: string[]
  groupShots: Map<number, string[]>
  motionOffset: number
  promptOffset: number
  energyAt?: EnergyAt
  /** Lyric lines to show, with when they are sung and shown. */
  lines: PlacedLine[]
  /** Visualizer videos: a scene and an overlay visualizer per kind of section. */
  backgrounds: Map<string, string>
  overlays: Map<string, string>
}

function warn(ctx: Pick<Ctx, 'warnings'>, message: string) {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message)
}

const round3 = (t: number) => Math.round(t * 1000) / 1000

function resolveLook(
  brief: CreativeBrief,
  input: PlannerInput,
  warnings: string[],
): { preset?: LookPreset; look?: PlanLook } {
  let preset = brief.lookId ? input.catalog.looks.find((l) => l.id === brief.lookId) : undefined
  if (brief.lookId && !preset)
    warnings.push(`Look "${brief.lookId}" isn't available, so a matching one was used.`)
  preset ??= pickLook(input.prompt, input.kind, input.catalog)
  if (!preset && !brief.adjustments) return {}
  const effects: EffectSpec[] = (preset?.effects ?? [])
    .filter((e) => findItem(input.catalog.effects, e.effectId))
    .map((e) => ({ effectId: e.effectId, params: e.params as EffectSpec['params'] }))
  return {
    preset,
    look: {
      id: preset?.id,
      name: preset?.name ?? 'Custom look',
      adjustments: { ...(preset?.adjustments ?? {}), ...(brief.adjustments ?? {}) },
      effects,
    },
  }
}

function resolveVisual(wanted: CreativeBrief['visual'], input: PlannerInput, warnings: string[]): Visual {
  const media = input.useMedia ? input.media : []
  const blank = input.useMedia && blankClipsNote(input.blank ?? [])
  if (blank) warnings.push(blank)
  const hasVideo = media.some((m) => m.kind === 'video')
  const hasImage = media.some((m) => m.kind === 'image')
  const hasGenerators = input.catalog.generators.length > 0
  const fallback = (): Visual => {
    if (hasVideo) return 'footage'
    if (hasImage) return 'stills'
    if (input.generation) return 'generated'
    return hasGenerators ? 'visualizer' : 'solid'
  }
  if (wanted === 'generated' && !input.generation) {
    warnings.push(NO_AI_SHOTS)
    return fallback()
  }
  if (wanted === 'footage' && !hasVideo && !hasImage) {
    warnings.push('Add clips or images to cut them to the beat. This draft uses other visuals for now.')
    return fallback()
  }
  if (wanted === 'stills' && !hasImage) return fallback()
  if (wanted === 'visualizer' && !hasGenerators) return 'solid'
  return wanted
}

function sanitizeSection(sb: BriefSection, section: SectionInfo, ctx: Ctx): BriefSection {
  const cat = ctx.input.catalog
  const effects = (sb.effects ?? []).filter((id) => {
    const ok = !!findItem(cat.effects, id)
    if (!ok) warn(ctx, `Effect "${id}" isn't available and was left out.`)
    return ok
  })
  const transition = sb.transition && findItem(cat.transitions, sb.transition) ? sb.transition : undefined
  if (sb.transition && !transition && sb.transition !== 'none' && sb.transition !== 'cut') {
    warn(ctx, `Transition "${sb.transition}" isn't available, so a hard cut is used.`)
  }
  return {
    ...sb,
    sectionId: section.id,
    effects,
    transition,
    generatorId:
      findItem(cat.generators, sb.generatorId)?.id ??
      bestByTags(cat.generators, moodFor(section).tags)?.id ??
      cat.generators[0]?.id,
    textPresetId: findItem(cat.textPresets, sb.textPresetId)?.id,
    assetIds: (sb.assetIds ?? []).filter((id) => ctx.input.media.some((m) => m.assetId === id)),
  }
}

function effectSpecs(sb: BriefSection, ctx: Ctx): EffectSpec[] {
  const reactive = sb.reactive ?? 0
  return (sb.effects ?? []).map((id) => {
    const item = findItem(ctx.input.catalog.effects, id)
    const params: Record<string, number | string | boolean> = {}
    for (const p of item?.params ?? []) {
      if (typeof p.default === 'number' || typeof p.default === 'string' || typeof p.default === 'boolean') {
        params[p.key] = p.default
      }
    }
    const driven = item?.params?.find((p) => p.modulatable && typeof p.default === 'number')
    return {
      effectId: id,
      params,
      ...(driven && reactive > 0
        ? {
            react: [
              {
                param: driven.key,
                source: 'loudness' as const,
                amount: round3(0.3 * reactive),
                smoothing: 0.3,
              },
            ],
          }
        : {}),
    }
  })
}

function pulse(sb: BriefSection): AudioBinding[] | undefined {
  const reactive = sb.reactive ?? 0
  if (reactive < 0.4) return undefined
  return [{ target: 'scale', source: 'beat', amount: round3(0.015 + 0.045 * reactive), smoothing: 0.25 }]
}

function transitionOf(ctx: Ctx, kind: string, duration: number): TransitionSpec | undefined {
  return findItem(ctx.input.catalog.transitions, kind) ? { kind, duration } : undefined
}

function boundaryTransition(
  prev: SectionInfo,
  section: SectionInfo,
  sb: BriefSection,
  ctx: Ctx,
): TransitionSpec | undefined {
  if (sb.transition) {
    const duration = sb.transition === 'flash' ? 0.15 : sb.transition === 'fade' ? 0.6 : 0.4
    return { kind: sb.transition, duration }
  }
  if (ctx.visual === 'visualizer' || ctx.visual === 'solid') return transitionOf(ctx, 'fade', 0.5)
  const delta = section.energy - prev.energy
  if (delta > 0.2) return transitionOf(ctx, 'flash', 0.15)
  if (delta < -0.2) return transitionOf(ctx, 'fade', 0.6)
  return undefined
}

function mediaPool(ctx: Ctx): MediaItem[] {
  if (!ctx.input.useMedia) return []
  const media = ctx.input.media
  if (ctx.visual === 'stills') return media.filter((m) => m.kind === 'image')
  return media
}

function nextMotion(sb: BriefSection, ctx: Ctx): Motion {
  if (sb.motion) return sb.motion
  return IMAGE_MOTIONS[(ctx.motionOffset + ctx.shotIndex) % IMAGE_MOTIONS.length] as Motion
}

const paceIndex = (pace: Pace) => PACES.indexOf(pace)

const nearest = (list: Seconds[], t: Seconds): Seconds | undefined =>
  list.reduce<Seconds | undefined>(
    (b, x) => (b === undefined || Math.abs(x - t) < Math.abs(b - t) ? x : b),
    undefined,
  )

/**
 * Keeps each lyric line on one shot: a cut that would land while a line is on screen moves to the nearest beat at a
 * line change (within most of a shot either way), else to the line change itself, off the beat. When neither is in
 * reach, the cut is dropped as long as the longer shot stays within about two planned shots; only past that does a
 * line change background under the words.
 */
function cutsBetweenLines(cuts: Seconds[], end: Seconds, k: number, ctx: Ctx): Seconds[] {
  if (ctx.lines.length === 0) return cuts
  const beat = ctx.grid.beatLength
  const reach = Math.max(k * beat * 0.75, beat * 2)
  const gap = Math.max(MIN_SHOT, beat * 2)
  const longest = k * beat * 2.2
  const onScreen = (t: Seconds) => ctx.lines.some((l) => t > l.shownStart + 0.12 && t < l.shownEnd - 0.12)
  const changes = ctx.lines.map((l) => l.shownStart)
  const out = [cuts[0] as number]
  for (let i = 1; i < cuts.length; i++) {
    const t = cuts[i] as number
    const prev = out[out.length - 1] as number
    const next = cuts[i + 1] ?? end
    if (!onScreen(t)) {
      out.push(t)
      continue
    }
    const ok = (b: Seconds) => Math.abs(b - t) <= reach && b - prev >= gap && next - b >= gap && !onScreen(b)
    const best = nearest(ctx.grid.beats.filter(ok), t) ?? nearest(changes.filter(ok), t)
    if (best !== undefined) out.push(best)
    else if (next - prev > longest) out.push(t)
  }
  return out
}

function shotSpans(section: SectionInfo, sb: BriefSection, ctx: Ctx, next?: BriefSection) {
  if (ctx.visual === 'generated' && ctx.input.generation?.mode === 'video') {
    const g = ctx.input.generation
    return spans(
      cutTimesByLength(section.start, section.end, g.videoDuration, g.maxVideoDuration, ctx.grid),
      section.end,
    )
  }
  const cap = (pace: Pace): Pace =>
    ctx.visual === 'generated' && paceIndex(pace) > paceIndex('slow') ? 'slow' : pace
  const pace = cap(sb.pace)
  const k = beatsPerCut(pace, ctx.grid.beatLength)
  const lift = next !== undefined && paceIndex(cap(next.pace)) > paceIndex(pace)
  let cuts = phrasedCutTimes(section.start, section.end, k, ctx.grid, { energyAt: ctx.energyAt, lift })
  if (ctx.input.kind === 'lyric') cuts = cutsBetweenLines(cuts, section.end, k, ctx)
  return spans(cuts, section.end)
}

function generatedSource(
  index: number,
  length: number,
  ctx: Ctx,
  sectionPromptList: string[],
): GenerateSource {
  const g = ctx.input.generation!
  const video = g.mode === 'video'
  const base = sectionPromptList[index % sectionPromptList.length] ?? ctx.concept
  const prompt = [base, ctx.promptStyle].filter(Boolean).join(', ')
  return {
    type: 'generate',
    task: video ? 'text-to-video' : 'text-to-image',
    prompt,
    modelId: video ? g.videoModelId : g.imageModelId,
    ...(video ? { duration: round3(length) } : {}),
  }
}

/** How hard scenes react to the music (their `reactivity`) by kind of section, so loud sections hit hardest. */
const REACTIVITY: Record<SectionTier, number> = { peak: 1.6, mid: 1, calm: 0.6 }
/** Behind lyrics, scenes stay calmer so the words lead. */
const LYRIC_REACTIVITY: Record<SectionTier, number> = { peak: 1, mid: 0.7, calm: 0.5 }
/** "Pulse with kick" on overlay visualizers. */
const KICK: Record<SectionTier, number> = { peak: 0.3, mid: 0.15, calm: 0 }

/** A color darkened toward black. */
function shade(hex: string, factor: number): string {
  const v = /^#([0-9a-f]{6})/i.exec(hex)?.[1]
  if (!v) return hex
  const channel = (i: number) =>
    Math.round(parseInt(v.slice(i, i + 2), 16) * factor)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(2)}${channel(4)}`
}

/** A generator colored by the look (darker behind lyrics), reacting by kind of section. */
function generatorSource(
  item: CatalogItem,
  tier: SectionTier,
  sb: BriefSection,
  ctx: Ctx,
  extra: Record<string, number> = {},
): ShotSource {
  const lyric = ctx.input.kind === 'lyric'
  const color = (c: string) => (lyric ? shade(c, 0.55) : c)
  const has = (key: string) => item.params?.some((p) => p.key === key)
  const palette = ctx.look?.palette
  const params: Record<string, string | number | boolean> = {}
  if (has('color')) {
    params.color = color(
      palette?.primary ??
        (sb.intensity >= 0.7 ? (ctx.look?.accentColor ?? '#22d3ee') : (ctx.look?.textColor ?? '#ffffff')),
    )
  }
  if (palette && has('color2')) params.color2 = color(palette.secondary)
  if (ctx.look && has('color3')) params.color3 = color(ctx.look.accentColor)
  if (has('reactivity')) params.reactivity = (lyric ? LYRIC_REACTIVITY : REACTIVITY)[tier]
  for (const [key, value] of Object.entries(extra)) if (has(key)) params[key] = value
  return { type: 'generator', generatorId: item.id, params }
}

const isScene = (g: CatalogItem | undefined) => !!g && g.id.startsWith('generator.')

/** Phrase length, in bars, of the overlay's rests in long sections. */
const PHRASE_BARS = 16

/**
 * When a section's overlay shows: all of it, or, in sections of 24 bars or more, every other 16-bar phrase from the
 * section's start (on downbeats), so a long verse does not hold one picture and the scene alone gets room. A last
 * phrase under 4 bars is left out.
 */
function overlaySpans(section: SectionInfo, ctx: Ctx): { start: Seconds; end: Seconds }[] {
  const bars = ctx.grid.downbeats.filter((d) => d >= section.start - 0.05 && d < section.end - 0.05)
  if (bars.length < 24) return [{ start: section.start, end: section.end }]
  const out: { start: Seconds; end: Seconds }[] = []
  for (let i = 0; i < bars.length; i += PHRASE_BARS * 2) {
    const start = i === 0 ? section.start : (bars[i] as Seconds)
    const end = bars[i + PHRASE_BARS] ?? section.end
    if (end - start >= ctx.grid.beatLength * 16) out.push({ start: round3(start), end: round3(end) })
  }
  return out
}

/**
 * A visualizer section in layers: a scene colored by the look that slowly pushes in or pulls out, a visualizer over
 * it that pulses with the kick (visualizer videos only), and particles on peaks. Over the user's images, the images
 * take the scene's place. The section's effects and beat pulse go on the top visual.
 */
function visualizerLayers(
  section: SectionInfo,
  sb: BriefSection,
  ctx: Ctx,
  withBackdrop: boolean,
  o: { effects: EffectSpec[]; reactive?: AudioBinding[] },
): PlanShot[] {
  const gens = ctx.input.catalog.generators
  const tier = sectionTier(section)
  const lyric = ctx.input.kind === 'lyric'
  const chosen = findItem(gens, sb.generatorId)
  const picked = (map: Map<string, string>) => findItem(gens, map.get(section.id))
  const background = withBackdrop
    ? undefined
    : chosen && (isScene(chosen) || !gens.some(isScene))
      ? chosen
      : (picked(ctx.backgrounds) ?? chosen)
  let overlay =
    ctx.input.kind === 'visualizer' || withBackdrop
      ? chosen && !isScene(chosen)
        ? chosen
        : picked(ctx.overlays)
      : undefined
  if (withBackdrop) overlay ??= chosen
  if (overlay === background) overlay = undefined
  const span = { sectionId: section.id, start: section.start, end: section.end }
  const top = overlay ?? background
  const shots: PlanShot[] = []
  if (background) {
    shots.push({
      ...span,
      id: newId(),
      layer: 'main',
      source: generatorSource(background, tier, sb, ctx),
      motion: ctx.shotIndex % 2 === 0 ? 'push-in' : 'pull-out',
      ...(top === background && o.effects.length ? { effects: o.effects } : {}),
      ...(top === background && o.reactive && !lyric ? { reactive: o.reactive } : {}),
    })
  }
  if (overlay) {
    const kick: ReactionSpec[] =
      KICK[tier] > 0 ? [{ reaction: 'kick', target: { property: 'scale' }, amount: KICK[tier] }] : []
    for (const part of background ? overlaySpans(section, ctx) : [span]) {
      shots.push({
        ...span,
        ...part,
        id: newId(),
        layer: 'overlay',
        // Spectrum bars at full height cover the scene; these masters keep their bands high.
        source: generatorSource(overlay, tier, sb, ctx, { height: 0.4 }),
        blendMode: 'screen',
        ...(o.effects.length ? { effects: o.effects } : {}),
        ...(kick.length ? { reactions: kick } : o.reactive ? { reactive: o.reactive } : {}),
      })
    }
  }
  const particles = findItem(gens, PARTICLES_ID)
  if (tier === 'peak' && particles && particles !== overlay && particles !== background) {
    shots.push({
      ...span,
      id: newId(),
      layer: 'accent',
      source: generatorSource(particles, tier, sb, ctx, {
        reactivity: lyric ? 1.2 : 2,
        density: lyric ? 0.35 : 0.6,
      }),
      blendMode: 'screen',
      ...(lyric ? { opacity: 0.7 } : {}),
    })
  }
  return shots
}

async function shotsForSection(
  section: SectionInfo,
  sb: BriefSection,
  ctx: Ctx,
  next?: BriefSection,
): Promise<PlanShot[]> {
  const shots: PlanShot[] = []
  const base = { sectionId: section.id, layer: 'main' as const }
  const effects = effectSpecs(sb, ctx)
  const reactive = pulse(sb)
  const dim =
    ctx.input.kind === 'lyric' && ctx.visual !== 'visualizer' && ctx.visual !== 'solid'
      ? { brightness: -0.2 }
      : undefined
  const decorate = (shot: PlanShot): PlanShot => ({
    ...shot,
    ...(effects.length ? { effects } : {}),
    ...(reactive ? { reactive } : {}),
    ...(dim ? { adjustments: { ...dim, ...shot.adjustments } } : {}),
  })

  if (ctx.visual === 'visualizer' || ctx.visual === 'solid') {
    const withBackdrop =
      ctx.input.kind === 'visualizer' && ctx.input.useMedia && ctx.input.media.some((m) => m.kind === 'image')
    if (withBackdrop) {
      const images = ctx.input.media.filter((m) => m.kind === 'image')
      const k = beatsPerCut('very-slow', ctx.grid.beatLength)
      for (const span of spans(cutTimes(section.start, section.end, k, ctx.grid), section.end)) {
        const image = images[ctx.shotIndex % images.length] as MediaItem
        shots.push({
          ...base,
          id: newId(),
          start: span.start,
          end: span.end,
          source: { type: 'media', assetId: image.assetId },
          motion: nextMotion(sb, ctx),
          adjustments: { brightness: -0.3, saturation: -0.2 },
        })
        ctx.shotIndex++
      }
    }
    if (ctx.visual === 'solid') {
      shots.push(
        decorate({
          ...base,
          id: newId(),
          start: section.start,
          end: section.end,
          source: { type: 'solid', color: '#101018' },
        }),
      )
    } else {
      shots.push(...visualizerLayers(section, sb, ctx, withBackdrop, { effects, reactive }))
    }
    ctx.shotIndex++
    return shots
  }

  const sectionSpans = shotSpans(section, sb, ctx, next)
  const calm = sb.intensity < 0.35 && (sb.pace === 'slow' || sb.pace === 'very-slow')
  const crossfade = calm ? transitionOf(ctx, 'fade', 0.4) : undefined

  if (ctx.visual === 'generated') {
    const g = ctx.input.generation!
    const lines = linesIn(ctx.input.lyrics, section.start, section.end)
    const prompts = sb.prompts?.length
      ? sb.prompts
      : sectionPrompts({
          concept: ctx.concept,
          mood: sb.mood,
          lyrics: lines,
          count: sectionSpans.length,
          offset: ctx.promptOffset,
        })
    ctx.promptOffset += sectionSpans.length
    // Repeated choruses reuse their shots (the visual hook comes back with the musical one); verses get new ones.
    const repeats = section.repeatGroup !== undefined && roleOf(section) === 'chorus'
    const reuse = repeats ? ctx.groupShots.get(section.repeatGroup as number) : undefined
    const own: string[] = []
    for (const [i, span] of sectionSpans.entries()) {
      const id = newId()
      const length = span.end - span.start
      let source = generatedSource(i, length, ctx, prompts)
      if (reuse?.length) {
        source = { ...source, sameAs: reuse[i % reuse.length] }
      } else if (ctx.generated.length >= g.maxShots && ctx.generated.length > 0) {
        source = { ...source, sameAs: ctx.generated[(ctx.shotIndex + i) % ctx.generated.length] }
        warn(
          ctx,
          `Limited to ${g.maxShots} generated ${g.mode === 'video' ? 'clips' : 'shots'} to keep the cost down; the rest reuse them.`,
        )
      } else {
        ctx.generated.push(id)
        own.push(id)
      }
      shots.push(
        decorate({
          ...base,
          id,
          start: span.start,
          end: span.end,
          source,
          ...(g.mode === 'images' ? { motion: nextMotion(sb, ctx) } : {}),
          ...(i > 0 && crossfade ? { transitionIn: crossfade } : {}),
          label: `${section.label} · ${g.mode === 'video' ? 'clip' : 'shot'} ${i + 1}`,
        }),
      )
      ctx.shotIndex++
    }
    if (repeats && !reuse?.length && own.length) ctx.groupShots.set(section.repeatGroup as number, own)
    return shots
  }

  const mood = footageMood(sb.mood, sb.intensity)
  for (const [i, span] of sectionSpans.entries()) {
    const shot = decorate({
      ...base,
      id: newId(),
      start: span.start,
      end: span.end,
      // Filled in by chooseFootage once every section has its shots.
      source: { type: 'media', assetId: 'pending' },
      ...(i > 0 && crossfade ? { transitionIn: crossfade } : {}),
    })
    ctx.pending.push({
      shot,
      sb,
      span: {
        start: span.start,
        end: span.end,
        energy: sb.intensity,
        ...(sb.mediaQuery ? { text: sb.mediaQuery } : {}),
        ...(mood ? { mood } : {}),
        ...(sb.assetIds?.length ? { prefer: sb.assetIds } : {}),
      },
    })
    shots.push(shot)
    ctx.shotIndex++
  }
  return shots
}

/** A footage or still shot waiting for its clip, chosen for all shots at once so variety spans the whole video. */
interface PendingShot {
  shot: PlanShot
  span: ChooseSpan
  sb: BriefSection
}

/**
 * Fills pending shots with src/vision's clip chooser (the same one auto-cut uses): it ranks clips for the line sung
 * during each shot, the section's media query and mood, and the music's energy when footage is analyzed, prefers
 * the brief's clips, never plays a clip twice in a row and never shows the same frames twice when it can avoid it.
 * Shots no clip can fill are dropped.
 */
async function chooseFootage(shots: PlanShot[], ctx: Ctx): Promise<PlanShot[]> {
  if (ctx.pending.length === 0) return shots
  const media = mediaPool(ctx).filter((m) => m.kind === 'image' || (m.duration ?? 0) > 0)
  const byId = new Map(media.map((m) => [m.assetId, m]))
  const pool: PoolItem[] = media.map((m) => ({
    assetId: m.assetId,
    kind: m.kind,
    name: m.name,
    ...(m.kind === 'video' ? { duration: m.duration } : {}),
    ...(m.index ? { index: m.index } : {}),
  }))
  const { picks, warnings } = await chooseClips({
    spans: ctx.pending.map((p) => p.span),
    pool,
    order: 'matched',
    ...(ctx.input.lyrics ? { lyrics: ctx.input.lyrics } : {}),
    ...(ctx.energyAt ? { energyAt: ctx.energyAt } : {}),
    ...(ctx.input.footage ? { matcher: ctx.input.footage } : {}),
    seed: ctx.input.seed,
  })
  // Without a matcher every pick is for variety, which needs no explaining in each draft.
  if (ctx.input.footage) for (const w of warnings) warn(ctx, w)
  const unfilled = new Set<PlanShot>()
  ctx.pending.forEach(({ shot, sb }, i) => {
    const pick = picks[i]
    const item = pick ? byId.get(pick.assetId) : undefined
    if (!pick || !item) {
      unfilled.add(shot)
      return
    }
    const length = shot.end - shot.start
    if (item.kind === 'image') {
      shot.source = { type: 'media', assetId: item.assetId }
      shot.motion = sb.motion ?? (IMAGE_MOTIONS[(ctx.motionOffset + i) % IMAGE_MOTIONS.length] as Motion)
      return
    }
    shot.source = {
      type: 'media',
      assetId: item.assetId,
      sourceStart: pick.sourceStart,
      ...(pick.playbackRate !== 1 ? { playbackRate: pick.playbackRate } : {}),
    }
    if ((item.duration ?? length) < length * 0.5)
      warn(ctx, `"${item.name}" is shorter than some shots, so it is slowed down.`)
  })
  return unfilled.size ? shots.filter((s) => !unfilled.has(s)) : shots
}

/**
 * A designed opening and ending: the first shot fades in from black and the last fades out, ending when the music
 * does when the song has a silent tail. Overlays fade with it.
 */
function openAndClose(shots: PlanShot[], ctx: Ctx): PlanShot[] {
  const stop = musicEnd(ctx.input.song)
  const kept = shots
    .filter((s) => s.start < stop - MIN_SHOT)
    .map((s) => (s.end > stop ? { ...s, end: stop } : s))
  const main = kept.filter((s) => s.layer === 'main')
  const first = main[0]
  const last = main[main.length - 1]
  const fadeIn = ctx.input.kind === 'beat-cut' ? 0.5 : 1
  if (first && first.start < 0.05 && !first.transitionIn) {
    const t = transitionOf(ctx, 'fade', fadeIn)
    if (t) first.transitionIn = t
  }
  const fadeOut = Math.min(2.5, Math.max(1.2, ctx.grid.beatLength * 4))
  for (const s of kept) {
    if (s !== last && !(s.layer === 'overlay' && Math.abs(s.end - (last?.end ?? -1)) < 0.05)) continue
    const t = transitionOf(ctx, 'fade', fadeOut)
    if (t) s.transitionOut = t
  }
  return kept
}

interface TimedLine {
  line: LyricLine
  start: Seconds
  end: Seconds
}

function timedLines(lines: LyricLine[], sections: SectionInfo[], duration: Seconds, ctx: Ctx): TimedLine[] {
  const withTimes = lines.map((line) => ({
    line,
    start: line.start ?? line.words[0]?.start,
    end: line.end ?? line.words[line.words.length - 1]?.end,
  }))
  const timed = withTimes.filter(
    (l): l is TimedLine => l.start !== undefined && l.end !== undefined && l.end > l.start,
  )
  if (timed.length >= lines.length / 2) {
    if (timed.length < lines.length)
      warn(ctx, `${lines.length - timed.length} lyric lines have no timing yet and were left out.`)
    return timed.sort((a, b) => a.start - b.start)
  }
  warn(
    ctx,
    "Lyrics aren't timed yet, so lines are spread evenly. Use Assist › Lyrics › Time words to the vocals, then run the director again.",
  )
  const vocal = sections.filter((s) => !['intro', 'outro'].includes(normalizedLabel(s.label)))
  const from = vocal[0]?.start ?? duration * 0.06
  const to = vocal[vocal.length - 1]?.end ?? duration * 0.94
  const weights = lines.map((l) => l.text.split(/\s+/).length + 2)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let t = from
  return lines.map((line, i) => {
    const length = ((to - from) * (weights[i] as number)) / total
    const item = { line, start: t, end: t + length }
    t += length
    return item
  })
}

/** Reading speed every lyric line gets when the gaps around it allow, in characters per second. */
const READ_CPS = 17
/** Most a line shows before it is sung, taken from the gap after the line before. */
const LEAD = 0.3
/** How long a line stays after it is sung, gaps allowing (longer when it needs more reading time). */
const HOLD = 1

/** When to show each line on screen: a little before it is sung until a while after, never overlapping. */
function displayTimes(timed: TimedLine[], duration: Seconds): { start: Seconds; end: Seconds }[] {
  const leads = timed.map((item, i) =>
    Math.max(0, Math.min(LEAD, (item.start - (timed[i - 1]?.end ?? 0)) * 0.4)),
  )
  const out: { start: Seconds; end: Seconds }[] = []
  for (const [i, item] of timed.entries()) {
    const start = Math.max(out[out.length - 1]?.end ?? 0, item.start - (leads[i] as number))
    const next = timed[i + 1]
    const nextShown = next ? next.start - (leads[i + 1] as number) : duration
    const need = Math.max(0.8, item.line.text.length / READ_CPS)
    const hold = Math.max(HOLD, need - (item.end - start))
    let end = Math.min(nextShown - 0.05, item.end + hold, duration)
    if (end - start < 0.6) end = Math.min(duration, start + 0.6)
    out.push({ start, end })
  }
  return out
}

interface PlacedLine extends TimedLine {
  shownStart: Seconds
  shownEnd: Seconds
  /** Index of the two-line passage the line belongs to; then shownStart..shownEnd is its turn as the current line. */
  passage?: number
}

/** A line on screen for less than this, or read faster than FAST_CPS, joins a two-line passage. */
const FAST_SHOWN = 1.2
const FAST_CPS = 15
/** Lines sung closer together than this belong to the same passage. */
const PASSAGE_GAP = 1
/** The next line waits below the current one at this size and opacity, then rolls up into place. */
const PREVIEW_SCALE = 0.72
const PREVIEW_OPACITY = 0.5
const ROLL = 0.2
/** Two one-row lines sung within this many seconds show together as a couplet. */
const COUPLET = 4
/**
 * Most a passage's first line shows before it is sung, taken from the hold of the line before (which keeps at least
 * PASSAGE_HOLD after it is sung): the first line has no turn as the next line to be read in.
 */
const PASSAGE_LEAD = 1.5
const PASSAGE_HOLD = 0.3

const isFast = (l: PlacedLine) => {
  const shown = l.shownEnd - l.shownStart
  return shown < FAST_SHOWN || l.line.text.length / shown > FAST_CPS
}

/**
 * Passages shown two lines at a time: runs of lines sung back to back (gaps under PASSAGE_GAP) with a line in them
 * that would flash by on its own.
 */
function twoLinePassages(lines: PlacedLine[]): PlacedLine[][] {
  const runs: PlacedLine[][] = []
  for (const l of lines) {
    const run = runs[runs.length - 1]
    const prev = run?.[run.length - 1]
    if (run && prev && l.start - prev.end < PASSAGE_GAP) run.push(l)
    else runs.push([l])
  }
  return runs.filter((run) => run.length >= 2 && run.some(isFast))
}

/**
 * When each line of a passage is the current one: from just before it is sung until just before the next is, the
 * first from up to PASSAGE_LEAD early and the last as long as it would show alone.
 */
function passageSlots(run: PlacedLine[], before: PlacedLine | undefined): { start: Seconds; end: Seconds }[] {
  const first = run[0] as PlacedLine
  const free = before ? Math.max(before.end + PASSAGE_HOLD, before.shownStart + 0.6) + 0.05 : 0
  let start = Math.min(first.shownStart, Math.max(free, first.start - PASSAGE_LEAD))
  return run.map((l, k) => {
    const next = run[k + 1]
    const end = next
      ? Math.max(start + 0.3, next.start - Math.min(0.12, Math.max(0, next.start - l.end) / 2))
      : Math.max(l.shownEnd, start + 0.6)
    const slot = { start: round3(start), end: round3(end) }
    start = end
    return slot
  })
}

/**
 * Lyric lines the draft shows, with when each is sung and when it is on screen (in a two-line passage, when it is the
 * current line).
 */
function placeLines(sections: SectionInfo[], ctx: Ctx): PlacedLine[] {
  const show = ctx.brief.text?.show ?? ctx.input.kind === 'lyric'
  const lines = ctx.input.lyrics?.lines.filter((l) => l.text.trim()) ?? []
  if (!show || lines.length === 0) return []
  const duration = ctx.input.song.duration
  const timed = timedLines(lines, sections, duration, ctx)
  const shown = displayTimes(timed, duration)
  const placed: PlacedLine[] = timed.flatMap((item, i) => {
    const s = shown[i] as { start: Seconds; end: Seconds }
    return s.end > s.start ? [{ ...item, shownStart: round3(s.start), shownEnd: round3(s.end) }] : []
  })
  for (const [n, run] of twoLinePassages(placed).entries()) {
    const before = placed[placed.indexOf(run[0] as PlacedLine) - 1]
    const slots = passageSlots(run, before)
    for (const [k, line] of run.entries()) {
      const slot = slots[k] as { start: Seconds; end: Seconds }
      Object.assign(line, { passage: n, shownStart: slot.start, shownEnd: slot.end })
    }
    if (before) before.shownEnd = Math.min(before.shownEnd, round3((slots[0]?.start ?? Infinity) - 0.05))
  }
  return placed
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The main shot playing at `t`, with its media. */
function mediaShotAt(t: Seconds, shots: PlanShot[], ctx: Ctx) {
  const shot = shots.find((s) => s.layer === 'main' && s.start <= t && s.end > t)
  if (shot?.source.type !== 'media') return undefined
  const { assetId } = shot.source
  const media = ctx.input.media.find((m) => m.assetId === assetId)
  return media ? { shot, source: shot.source, media } : undefined
}

/** Subject samples of a shot's media while [start, end) of the timeline plays, in source time. */
function subjectsDuring(at: NonNullable<ReturnType<typeof mediaShotAt>>, start: Seconds, end: Seconds) {
  const track = at.media.subjects
  if (!track) return []
  const rate = at.source.playbackRate ?? 1
  const from = (at.source.sourceStart ?? 0) + (Math.max(start, at.shot.start) - at.shot.start) * rate
  const to = (at.source.sourceStart ?? 0) + (Math.min(end, at.shot.end) - at.shot.start) * rate
  const still = at.media.kind === 'image'
  return track.samples.filter(
    (s) => (still || (s.t >= from - 0.1 && s.t <= to + 0.1)) && s.source !== 'none' && s.confidence >= 0.3,
  )
}

/** The part of a source (normalized, top-left origin) a frame shows when the source is cropped to fill it. */
function visiblePart(source: { width: number; height: number }, ctx: Ctx): Box {
  const frame = ctx.input.settings.width / Math.max(1, ctx.input.settings.height)
  const aspect = source.width / Math.max(1, source.height)
  if (aspect > frame) return { x: (1 - frame / aspect) / 2, y: 0, width: frame / aspect, height: 1 }
  return { x: 0, y: (1 - aspect / frame) / 2, width: 1, height: aspect / frame }
}

/** People shorter than this (fraction of the frame height) are far from the camera; text may cover them. */
const NEAR_SUBJECT = 0.3

/**
 * Faces (or upper bodies) of people near the camera on screen while a line shows, in every shot it spans, as frame
 * boxes (top-left origin, cropped to fill).
 */
function facesDuring(start: Seconds, end: Seconds, shots: PlanShot[], ctx: Ctx): Box[] {
  return shots
    .filter((s) => s.layer === 'main' && s.start < end && s.end > start)
    .flatMap((s) => {
      const at = mediaShotAt(Math.max(start, s.start), shots, ctx)
      const track = at?.media.subjects
      if (!at || !track) return []
      const v = visiblePart(track.sourceSize, ctx)
      const toFrame = (x: number, y: number) => ({ x: (x - v.x) / v.width, y: (y - v.y) / v.height })
      return subjectsDuring(at, start, end).flatMap((sample) => {
        if (sample.box && sample.box.height / v.height < NEAR_SUBJECT) return []
        const c = toFrame(sample.focus.x, sample.focus.y)
        const r = sample.source === 'face' ? { w: 0.08, h: 0.12 } : { w: 0.1, h: 0.16 }
        return [{ x: c.x - r.w, y: c.y - r.h, width: r.w * 2, height: r.h * 2 }]
      })
    })
}

/**
 * Where to center a block of text `height` tall and `width` wide (fractions of the frame): `preferred` unless a face
 * would be under it, then the lower or upper third, whichever covers the fewest faces (`hits`). Always inside the
 * title-safe area.
 */
function clearOfFaces(
  preferred: number,
  height: number,
  width: number,
  faces: Box[],
): { y: number; hits: number } {
  const safe = (y: number) => Math.min(0.92 - height / 2, Math.max(0.08 + height / 2, y))
  const options = [...new Set([preferred, 0.76, 0.26].map((y) => round3(safe(y))))]
  const hits = (y: number) =>
    faces.filter(
      (f) =>
        f.x < 0.5 + width / 2 &&
        f.x + f.width > 0.5 - width / 2 &&
        f.y < y + height / 2 &&
        f.y + f.height > y - height / 2,
    ).length
  let best = options[0] as number
  let fewest = hits(best)
  for (const y of options.slice(1)) {
    const n = hits(y)
    if (n < fewest) {
      best = y
      fewest = n
    }
  }
  return { y: best, hits: fewest }
}

/**
 * Lyrics behind the subject for one chorus: lines of the first peak section that each stay on one shot of a clip with
 * a subject mask, and (when its people are tracked) a person tall enough to hide part of the words. Four lines at most.
 */
function behindLines(lines: PlacedLine[], sections: SectionInfo[], shots: PlanShot[], ctx: Ctx) {
  const out = new Map<PlacedLine, NonNullable<PlanText['behind']>>()
  for (const section of sections.filter(isPeak)) {
    for (const line of lines.filter((l) => l.start >= section.start && l.start < section.end)) {
      const at = mediaShotAt(line.shownStart + 1e-3, shots, ctx)
      if (!at?.media.subjectMask || at.shot.end < line.shownEnd - 1e-3) continue
      const tall = subjectsDuring(at, line.shownStart, line.shownEnd).some(
        (s) => (s.box?.height ?? 0) >= 0.35,
      )
      if (at.media.subjects && !tall) continue
      out.set(line, { maskAssetId: at.media.subjectMask, sourceAssetId: at.media.assetId })
      if (out.size >= 4) return out
    }
    if (out.size) return out
  }
  return out
}

/** Height of laid-out text as a fraction of the frame. */
const blockHeight = (rows: number, style: TextStyleSpec) =>
  (rows * (style.lineHeight ?? 1.15) * (style.fontSize ?? 80)) / 1080

/** Width of the widest row as a fraction of the frame. */
function blockWidth(text: string, style: TextStyleSpec, aspect: EditPlan['aspect']): number {
  return Math.max(...text.split('\n').map((row) => textWidth(row, style))) / frameWidth(aspect)
}

/**
 * The text clips of one lyric line. Long enough lines with a stressed last word (every chorus line, other lines when
 * the word is long or a hook) split in two: the line without it, linked to the lyrics for karaoke, and the word itself
 * below it, bigger and in the accent color, entering as it is sung. Lines behind the subject stay whole and big.
 */
function lineTexts(
  item: PlacedLine,
  o: {
    section?: SectionInfo
    sb?: BriefSection
    type: LyricTypography
    anchor: number
    hooks: ReadonlySet<string>
    behind?: NonNullable<PlanText['behind']>
    shots: PlanShot[]
    fade?: TransitionSpec
    ctx: Ctx
  },
): PlanText[] {
  const { type, sb, section, ctx } = o
  const aspect = type.aspect
  const peak = !!section && isPeak(section) && (sb?.intensity ?? section.energy) >= 0.6
  const lineStyle = peak ? peakStyle(type, ctx.brief.text) : type.style
  const words = item.line.text.split(/\s+/).filter(Boolean)
  const timedWords = item.line.words.length > 0 && item.line.words.every((w) => w.end > w.start)
  const animation = sb?.textPresetId ?? type.lineAnimation
  const pulse =
    peak && (sb?.reactive ?? 0) >= 0.5
      ? { reactive: [{ target: 'scale' as const, source: 'beat' as const, amount: 0.03, smoothing: 0.3 }] }
      : {}
  const line = (text: string, style: TextStyleSpec, y: number): PlanText => ({
    id: newId(),
    sectionId: section?.id,
    start: item.shownStart,
    end: item.shownEnd,
    text,
    lyricLineId: item.line.id,
    style,
    position: { x: 0.5, y: round3(y) },
    ...(animation
      ? { animationPresetId: animation }
      : o.fade
        ? { transitionIn: o.fade, transitionOut: o.fade }
        : {}),
    ...(type.karaoke && timedWords
      ? { karaoke: { highlightColor: type.accent, mode: 'word' as const } }
      : {}),
    role: 'lyric',
  })
  const faces = facesDuring(item.shownStart, item.shownEnd, o.shots, ctx)

  if (o.behind) {
    const big = { ...lineStyle, fontSize: Math.round(type.lineSize * 1.35) }
    const laid = layoutLine(item.line.text, big, aspect)
    return [{ ...line(laid.text, { ...big, fontSize: laid.fontSize }, 0.5), behind: o.behind, ...pulse }]
  }

  const laid = layoutLine(item.line.text, lineStyle, aspect)
  const style = { ...lineStyle, fontSize: laid.fontSize }
  const whole = clearOfFaces(
    o.anchor,
    blockHeight(laid.rows, style),
    blockWidth(laid.text, style, aspect),
    faces,
  )

  const split = emphasisStart(words, { peak, hooks: o.hooks })
  const tailAt =
    split === undefined
      ? undefined
      : round3(Math.max(item.shownStart + 0.1, wordTime(item, words, split) - 0.06))
  if (split !== undefined && tailAt !== undefined && item.shownEnd - tailAt >= 0.5) {
    const head = layoutLine(words.slice(0, split).join(' '), lineStyle, aspect)
    const headStyle = { ...lineStyle, fontSize: head.fontSize }
    const tailText = words.slice(split).join(' ')
    const tailStyle = emphasisStyle(type, lineStyle, tailText)
    const headH = blockHeight(head.rows, headStyle)
    const tailH = blockHeight(1, tailStyle)
    const total = headH + 0.012 + tailH
    const width = Math.max(blockWidth(head.text, headStyle, aspect), blockWidth(tailText, tailStyle, aspect))
    const placed = clearOfFaces(o.anchor, total, width, faces)
    const top = placed.y - total / 2
    const emphasis = type.emphasisAnimation
    // The split block is taller: when no place for it clears the faces, the whole line may.
    if (placed.hits <= whole.hits)
      return [
        line(head.text, headStyle, top + headH / 2),
        {
          id: newId(),
          sectionId: section?.id,
          start: tailAt,
          end: item.shownEnd,
          text: tailText,
          lyricLineId: item.line.id,
          style: tailStyle,
          position: { x: 0.5, y: round3(top + total - tailH / 2) },
          ...(emphasis
            ? { animationPresetId: emphasis }
            : o.fade
              ? { transitionIn: o.fade, transitionOut: o.fade }
              : {}),
          ...pulse,
          role: 'emphasis',
        },
      ]
  }

  return [{ ...line(laid.text, style, whole.y), ...pulse }]
}

/**
 * The text clips of a fast passage, two lines at a time in the look's text style: the current line in full with its
 * karaoke, and the next one below it, smaller and dimmer (role 'preview'), rolling up into place when its turn comes,
 * so no line flashes by. Two short lines sung close together form a couplet: both stay on screen until the second is
 * sung. No emphasized words or beat pulses here; there is no time for them.
 */
function passageTexts(
  run: PlacedLine[],
  o: {
    sectionAt: (t: Seconds) => SectionInfo | undefined
    briefs: Map<string, BriefSection>
    type: LyricTypography
    anchor: number
    shots: PlanShot[]
    fade?: TransitionSpec
    ctx: Ctx
  },
): PlanText[] {
  const { type, ctx } = o
  const aspect = type.aspect
  const slots = run.map((l) => ({ start: l.shownStart, end: l.shownEnd }))
  const layout = (item: PlacedLine) => {
    const section = o.sectionAt(item.start)
    const sb = section ? o.briefs.get(section.id) : undefined
    const peak = !!section && isPeak(section) && (sb?.intensity ?? section.energy) >= 0.6
    const lineStyle = peak ? peakStyle(type, ctx.brief.text) : type.style
    const laid = layoutLine(item.line.text, lineStyle, aspect)
    const style = { ...lineStyle, fontSize: laid.fontSize }
    return {
      item,
      section,
      animation: sb?.textPresetId ?? type.lineAnimation,
      text: laid.text,
      rows: laid.rows,
      style,
      height: blockHeight(laid.rows, style),
      width: blockWidth(laid.text, style, aspect),
    }
  }
  type Laid = ReturnType<typeof layout>
  const timedWords = (l: Laid) =>
    l.item.line.words.length > 0 && l.item.line.words.every((w) => w.end > w.start)
  const text = (l: Laid, start: Seconds, end: Seconds, y: number, extra: Partial<PlanText>): PlanText => ({
    id: newId(),
    sectionId: l.section?.id,
    start,
    end,
    text: l.text,
    lyricLineId: l.item.line.id,
    style: l.style,
    position: { x: 0.5, y: round3(y) },
    role: 'lyric',
    ...extra,
  })
  const current = (
    l: Laid,
    start: Seconds,
    end: Seconds,
    y: number,
    entering: PlanText['enter'],
    last: boolean,
  ) =>
    text(l, start, end, y, {
      // A line that was waiting below rolls up without its entrance animation, which would hide words again.
      ...(entering ? { enter: entering } : l.animation ? { animationPresetId: l.animation } : {}),
      ...(!entering && !l.animation && o.fade ? { transitionIn: o.fade } : {}),
      ...(o.fade ? { transitionOut: last ? o.fade : { ...o.fade, duration: 0.12 } } : {}),
      ...(type.karaoke && timedWords(l)
        ? { karaoke: { highlightColor: type.accent, mode: 'word' as const } }
        : {}),
    })
  const preview = (l: Laid, start: Seconds, end: Seconds, y: number) =>
    text(l, start, end, y, {
      role: 'preview',
      opacity: PREVIEW_OPACITY,
      scale: PREVIEW_SCALE,
      ...(o.fade ? { transitionIn: o.fade } : {}),
    })
  const blocks = run.map(layout)
  const readsAlone = (k: number) => {
    const slot = slots[k] as { start: Seconds; end: Seconds }
    const shown = slot.end - slot.start
    return shown >= FAST_SHOWN && (blocks[k] as Laid).item.line.text.length / shown <= FAST_CPS
  }
  // The line after a couplet gets no turn waiting below, so a couplet forms only when that line reads in its own
  // turn or starts a couplet itself.
  const couplet: boolean[] = []
  for (let k = run.length - 2; k >= 0; k--) {
    const a = blocks[k] as Laid
    const b = blocks[k + 1] as Laid
    couplet[k] =
      a.rows === 1 &&
      b.rows === 1 &&
      b.item.end - a.item.start <= COUPLET &&
      (k + 2 >= run.length || readsAlone(k + 2) || !!couplet[k + 2])
  }
  const gap = 0.015
  const out: PlanText[] = []
  let waiting: { y: number } | undefined
  for (let k = 0; k < run.length;) {
    const a = blocks[k] as Laid
    const slotA = slots[k] as { start: Seconds; end: Seconds }
    const b = blocks[k + 1]
    if (!waiting && b && couplet[k]) {
      const slotB = slots[k + 1] as { start: Seconds; end: Seconds }
      const total = a.height + gap + b.height
      const faces = facesDuring(slotA.start, slotB.end, o.shots, ctx)
      const top = clearOfFaces(o.anchor, total, Math.max(a.width, b.width), faces).y - total / 2
      const yB = top + a.height + gap + b.height / 2
      const last = k + 2 >= run.length
      out.push(
        current(a, slotA.start, slotB.end, top + a.height / 2, undefined, last),
        preview(b, slotA.start, slotA.end, yB),
        current(
          b,
          slotB.start,
          slotB.end,
          yB,
          { scale: PREVIEW_SCALE, opacity: PREVIEW_OPACITY, duration: ROLL },
          last,
        ),
      )
      k += 2
      continue
    }
    const total = a.height + (b ? gap + b.height * PREVIEW_SCALE : 0)
    const faces = facesDuring(slotA.start, slotA.end, o.shots, ctx)
    const width = Math.max(a.width, b ? b.width * PREVIEW_SCALE : 0)
    const top = clearOfFaces(o.anchor, total, width, faces).y - total / 2
    const entering = waiting
      ? { y: round3(waiting.y), scale: PREVIEW_SCALE, opacity: PREVIEW_OPACITY, duration: ROLL }
      : undefined
    out.push(current(a, slotA.start, slotA.end, top + a.height / 2, entering, !b))
    waiting = undefined
    if (b) {
      const y = top + a.height + gap + (b.height * PREVIEW_SCALE) / 2
      out.push(preview(b, slotA.start, slotA.end, y))
      waiting = { y }
    }
    k += 1
  }
  return out
}
/** Mean luma under a text box from which the text gets a scrim. */
const BRIGHT = 0.5

/**
 * Soft dark scrims behind text over bright footage, whatever the look: the frames under each text box are measured
 * as it appears and midway, and text whose brighter sample passes BRIGHT gets a rounded dark box behind each row
 * (an emphasized word, a dark halo).
 */
async function scrimBrightText(texts: PlanText[], shots: PlanShot[], ctx: Ctx): Promise<void> {
  const probe = ctx.input.brightness
  if (!probe || (ctx.visual !== 'footage' && ctx.visual !== 'stills')) return
  const aspect = ctx.input.settings.aspect
  const requests: BrightnessRequest[] = []
  const owners: PlanText[] = []
  for (const t of texts) {
    const width = Math.min(1, blockWidth(t.text, t.style, aspect) + 0.04)
    const height = blockHeight(t.text.split('\n').length, t.style) + 0.03
    const box = { x: t.position.x - width / 2, y: t.position.y - height / 2, width, height }
    for (const time of [t.start + Math.min(0.3, (t.end - t.start) / 4), (t.start + t.end) / 2]) {
      const at = mediaShotAt(time, shots, ctx)
      if (!at) continue
      const v = visiblePart({ width: at.media.width ?? 16, height: at.media.height ?? 9 }, ctx)
      const rate = at.source.playbackRate ?? 1
      requests.push({
        assetId: at.media.assetId,
        time: (at.source.sourceStart ?? 0) + (time - at.shot.start) * rate,
        box: {
          x: v.x + box.x * v.width,
          y: v.y + box.y * v.height,
          width: box.width * v.width,
          height: box.height * v.height,
        },
      })
      owners.push(t)
    }
  }
  if (requests.length === 0) return
  const lumas = await probe(requests).catch(() => [] as (number | undefined)[])
  const brightest = new Map<PlanText, number>()
  lumas.forEach((luma, i) => {
    const owner = owners[i] as PlanText
    if (luma !== undefined) brightest.set(owner, Math.max(brightest.get(owner) ?? 0, luma))
  })
  for (const [t, luma] of brightest) {
    if (luma < BRIGHT || t.style.background) continue
    const size = t.style.fontSize ?? 80
    // An emphasized word zooms or drops in; a box would show at full size before it, so it gets a dark halo instead.
    t.style =
      t.role === 'emphasis'
        ? {
            ...t.style,
            shadow: { color: '#000000cc', blur: Math.round(size * 0.25), offsetX: 0, offsetY: 2 },
          }
        : {
            ...t.style,
            background: {
              color: '#00000080',
              padding: Math.round(size * 0.2),
              radius: Math.round(size * 0.16),
            },
          }
  }
}

function buildTexts(
  sections: SectionInfo[],
  briefs: Map<string, BriefSection>,
  shots: PlanShot[],
  ctx: Ctx,
  titleText: string,
): PlanText[] {
  const { input, brief } = ctx
  const texts: PlanText[] = []
  const aspect = input.settings.aspect
  const textBrief = brief.text
  const busy = ctx.visual === 'footage' || ctx.visual === 'stills' || ctx.visual === 'generated'
  const type = lyricTypography({ look: ctx.look, aspect, busy, brief: textBrief, catalog: input.catalog })
  const position = textBrief?.position ?? (busy && input.kind !== 'lyric' ? 'lower' : 'center')
  const anchor = position === 'lower' ? 0.8 : position === 'upper' ? 0.2 : 0.5
  const sectionAt = (t: number) =>
    sections.find((s) => t >= s.start && t < s.end) ?? sections[sections.length - 1]
  const fade = transitionOf(ctx, 'fade', 0.15)

  if (ctx.lines.length > 0) {
    const chorusLines = ctx.lines.filter((l) => {
      const s = sectionAt(l.start)
      return !!s && isPeak(s)
    })
    const hooks = hookWords(
      input.song.title,
      chorusLines.map((l) => l.line.text),
    )
    const behind = behindLines(
      ctx.lines.filter((l) => l.passage === undefined),
      sections,
      shots,
      ctx,
    )
    for (const [i, item] of ctx.lines.entries()) {
      if (item.passage !== undefined) {
        if (ctx.lines[i - 1]?.passage !== item.passage) {
          const run = ctx.lines.filter((l) => l.passage === item.passage)
          texts.push(...passageTexts(run, { sectionAt, briefs, type, anchor, shots, fade, ctx }))
        }
        continue
      }
      const section = sectionAt(item.start)
      texts.push(
        ...lineTexts(item, {
          section,
          sb: section ? briefs.get(section.id) : undefined,
          type,
          anchor,
          hooks,
          behind: behind.get(item),
          shots,
          fade,
          ctx,
        }),
      )
    }
  } else if (input.kind === 'lyric') {
    warn(ctx, 'Add lyrics in Assist › Lyrics, then run the director again to place them.')
  }

  // A title card over the intro: the song's title (and artist), not the prompt or the kind of video.
  const first = sections[0]
  const firstLyric = texts[0]?.start ?? Infinity
  const titleEnd = Math.min(first ? first.end : 0, 4.5, firstLyric - 0.2)
  if (input.kind !== 'beat-cut' && first && titleEnd >= 2.5 && titleText) {
    const fades = fade
      ? { transitionIn: { kind: 'fade', duration: 0.6 }, transitionOut: { kind: 'fade', duration: 0.6 } }
      : {}
    const artist = input.song.title && titleText === input.song.title ? input.song.artist : undefined
    const titleLaid = layoutLine(titleText, titleStyle(type, 1.3, 800, 0.12), aspect)
    const bigStyle = { ...titleStyle(type, 1.3, 800, 0.12), fontSize: titleLaid.fontSize }
    const smallStyle = titleStyle(type, 0.56, type.style.fontWeight ?? 700, 0.3)
    const titleH = blockHeight(titleLaid.rows, bigStyle)
    const artistH = artist ? 0.02 + blockHeight(1, smallStyle) : 0
    const top = 0.5 - (titleH + artistH) / 2
    const card: PlanText[] = [
      {
        id: newId(),
        sectionId: first.id,
        start: 0.5,
        end: round3(titleEnd),
        text: titleLaid.text,
        style: bigStyle,
        position: { x: 0.5, y: round3(top + titleH / 2) },
        ...fades,
        role: 'title',
      },
    ]
    if (artist) {
      card.push({
        id: newId(),
        sectionId: first.id,
        start: 0.8,
        end: round3(titleEnd),
        text: artist,
        style: smallStyle,
        position: { x: 0.5, y: round3(top + titleH + 0.02 + blockHeight(1, smallStyle) / 2) },
        ...fades,
        role: 'title',
      })
    }
    texts.unshift(...card)
  }
  return texts
}

/**
 * Asks for each AI video clip as long as the longest shot that shows it, once every shot has its final times: a clip
 * reused in a longer shot (a repeated chorus, the shot limit) would otherwise run out before the shot ends.
 */
function clipLengths(shots: PlanShot[]): PlanShot[] {
  const needed = new Map<string, Seconds>()
  for (const s of shots) {
    if (s.source.type !== 'generate' || s.source.task === 'text-to-image') continue
    const id = s.source.sameAs ?? s.id
    needed.set(id, Math.max(needed.get(id) ?? 0, s.end - s.start))
  }
  return shots.map((s) => {
    const length = needed.get(s.id)
    return s.source.type === 'generate' && !s.source.sameAs && length !== undefined
      ? { ...s, source: { ...s.source, duration: round3(length) } }
      : s
  })
}

const toGenerate = (count: number) => `${count} to generate`

/** The plan's summary counting only the AI shots still to generate, once some are made (kept after a Cancel). */
export function summaryLeft(plan: Pick<EditPlan, 'summary' | 'shots'>, left: number): string {
  const total = shotsToGenerate(plan).length
  if (left >= total) return plan.summary
  return plan.summary.replace(`, ${toGenerate(total)}`, left > 0 ? `, ${toGenerate(left)}` : '')
}

function summarize(plan: Omit<EditPlan, 'summary'>, ctx: Ctx): string {
  const main = plan.shots.filter((s) => s.layer === 'main')
  const mediaIds = new Set(main.flatMap((s) => (s.source.type === 'media' ? [s.source.assetId] : [])))
  const generated = shotsToGenerate(plan).length
  const lyricCount = plan.texts.filter((t) => t.role === 'lyric').length
  const parts = [`${KIND_NAME[plan.kind]} with ${plan.sections.length} sections`]
  if (ctx.visual === 'visualizer') parts.push('music-reactive visuals')
  else if (main.length) parts.push(`${main.length} shots`)
  if (mediaIds.size) parts.push(`${mediaIds.size} of your ${mediaIds.size === 1 ? 'clip' : 'clips'}`)
  if (generated) parts.push(toGenerate(generated))
  if (lyricCount) parts.push(`${lyricCount} lyric lines`)
  if (plan.look) parts.push(`${plan.look.name} look`)
  const pacing =
    ctx.visual === 'footage' || ctx.visual === 'stills'
      ? ' Cuts land on the beat, faster in choruses and loud passages and slower in quiet ones.'
      : ''
  return `${parts.join(', ')}.${pacing}`
}

export interface ExpandMeta {
  planner: 'local' | 'llm'
  model?: string
}

export async function expandBrief(
  brief: CreativeBrief,
  input: PlannerInput,
  meta: ExpandMeta,
): Promise<EditPlan> {
  if (!(input.song.duration > 0)) {
    throw new DirectorError('no-song', 'Add a song first. The director builds the video around it.')
  }
  const warnings: string[] = []
  if (!input.song.analyzed) {
    warnings.push(
      'Song analysis isn’t finished, so cuts follow an even tempo grid. Run the director again when beats and sections are ready.',
    )
  }
  const grid = beatGrid(input.song)
  const sections = sectionsFor(input.song, grid)
  const { preset, look } = resolveLook(brief, input, warnings)
  const visual = resolveVisual(brief.visual, input, warnings)
  const rng = createRng(input.seed)
  const ctx: Ctx = {
    input,
    brief,
    grid,
    rng,
    warnings,
    look: preset,
    visual,
    concept: visualIdea(brief.concept) || visualIdea(input.prompt) || DEFAULT_CONCEPT[input.kind],
    promptStyle: brief.promptStyle ?? preset?.promptStyle ?? '',
    pending: [],
    shotIndex: 0,
    generated: [],
    groupShots: new Map(),
    motionOffset: Math.floor(rng() * IMAGE_MOTIONS.length),
    promptOffset: Math.floor(rng() * 6),
    energyAt: energyScale(input.song),
    lines: [],
    backgrounds: visualizerPalette(sections, input, scenePool(input)),
    overlays: visualizerPalette(sections, input, overlayPool(input)),
  }
  ctx.lines = placeLines(sections, ctx)
  const given = new Map(brief.sections.map((s) => [s.sectionId, s]))
  const briefs = new Map<string, BriefSection>()
  const planSections: PlanSection[] = []
  for (const section of sections) {
    const raw = given.get(section.id) ?? defaultSectionBrief(section, input, grid.bpm, visual === 'generated')
    const sb = sanitizeSection(raw, section, ctx)
    briefs.set(section.id, sb)
    planSections.push({
      id: section.id,
      label: section.label,
      start: round3(section.start),
      end: round3(section.end),
      energy: section.energy,
      mood: sb.mood,
      pace: sb.pace,
    })
  }
  let shots: PlanShot[] = []
  for (const [i, section] of sections.entries()) {
    const sb = briefs.get(section.id) as BriefSection
    const next = sections[i + 1]
    const sectionShots = await shotsForSection(section, sb, ctx, next ? briefs.get(next.id) : undefined)
    const firstMain = sectionShots.find((s) => s.layer === 'main')
    if (i > 0 && firstMain && !firstMain.transitionIn) {
      const t = boundaryTransition(sections[i - 1] as SectionInfo, section, sb, ctx)
      if (t) firstMain.transitionIn = t
    }
    shots.push(...sectionShots)
  }
  shots = clipLengths(openAndClose(await chooseFootage(shots, ctx), ctx))
  const titleText = input.song.title ?? (meta.planner === 'llm' ? brief.title.trim() : '')
  const texts = buildTexts(sections, briefs, shots, ctx, titleText)
  await scrimBrightText(texts, shots, ctx)
  const draft: Omit<EditPlan, 'summary'> = {
    version: 1,
    id: newId(),
    kind: input.kind,
    title: brief.title.trim() || KIND_NAME[input.kind],
    concept: ctx.concept,
    prompt: input.prompt,
    planner: meta.planner,
    ...(meta.model ? { model: meta.model } : {}),
    seed: input.seed,
    aspect: input.settings.aspect,
    duration: input.song.duration,
    ...(input.song.assetId ? { songAssetId: input.song.assetId } : {}),
    sections: planSections,
    shots: shots.map((s) => ({ ...s, start: round3(s.start), end: round3(s.end) })),
    texts,
    ...(look ? { look } : {}),
    warnings,
  }
  const result = editPlanSchema.safeParse({ ...draft, summary: summarize(draft, ctx) })
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new DirectorError(
      'invalid-plan',
      `The director made an invalid plan: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'}`,
    )
  }
  return result.data
}
