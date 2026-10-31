/**
 * Turns a creative brief (from the rules or an LLM) into an exact EditPlan: beat- and bar-aligned shots, media
 * choices, generation prompts, transitions, effects, audio-reactive bindings, lyric text and a look. Anything the
 * brief leaves out or gets wrong (unknown ids, missing sections) falls back to the rules with a warning.
 */
import { newId } from '../model/factory.ts'
import type { LyricLine, Seconds } from '../model/types.ts'
import { JobError } from '../shared/jobs.ts'
import { chooseClips, type ChooseSpan, type PoolItem } from '../vision/index.ts'
import type { BriefSection, CreativeBrief } from './brief.ts'
import { bestByTags, findItem, type LookPreset } from './catalog.ts'
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
  pickLook,
  sectionPrompts,
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
  type BeatGrid,
} from './timing.ts'

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
  /** When each timed lyric line is sung. */
  sung: { start: Seconds; end: Seconds }[]
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
    warnings.push(
      'This draft uses your media or visuals. To generate AI scenes, connect fal.ai in Settings and turn on AI shots.',
    )
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

/**
 * Moves cuts that would land in the middle of a sung line to the nearest beat where a line starts or between lines,
 * within half a shot either way, so the background changes with the words instead of under them.
 */
function cutsBetweenLines(cuts: Seconds[], end: Seconds, k: number, ctx: Ctx): Seconds[] {
  if (ctx.sung.length === 0) return cuts
  const reach = (k * ctx.grid.beatLength) / 2
  const gap = Math.max(MIN_SHOT, ctx.grid.beatLength * 2)
  const free = (t: Seconds) => !ctx.sung.some((l) => t > l.start + 0.2 && t < l.end - 0.1)
  const out = [cuts[0] as number]
  for (let i = 1; i < cuts.length; i++) {
    const t = cuts[i] as number
    const prev = out[out.length - 1] as number
    const next = cuts[i + 1] ?? end
    if (free(t)) {
      out.push(t)
      continue
    }
    let best: Seconds | undefined
    for (const b of ctx.grid.beats) {
      if (Math.abs(b - t) > reach || b - prev < gap || next - b < gap || !free(b)) continue
      if (best === undefined || Math.abs(b - t) < Math.abs(best - t)) best = b
    }
    out.push(best ?? t)
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
      const generator = findItem(ctx.input.catalog.generators, sb.generatorId)
      const params: Record<string, string | number | boolean> = {}
      const has = (key: string) => generator?.params?.some((p) => p.key === key)
      const palette = ctx.look?.palette
      if (has('color')) {
        params.color =
          palette?.primary ??
          (sb.intensity >= 0.7 ? (ctx.look?.accentColor ?? '#22d3ee') : (ctx.look?.textColor ?? '#ffffff'))
      }
      if (palette && has('color2')) params.color2 = palette.secondary
      shots.push({
        ...base,
        layer: withBackdrop ? 'overlay' : 'main',
        id: newId(),
        start: section.start,
        end: section.end,
        source: { type: 'generator', generatorId: generator?.id ?? (sb.generatorId as string), params },
        ...(withBackdrop ? { blendMode: 'screen' as const } : {}),
        ...(reactive ? { reactive } : {}),
        ...(effects.length ? { effects } : {}),
      })
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
    const repeats = section.repeatGroup !== undefined && normalizedLabel(section.label) === 'chorus'
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
        warn(ctx, `Limited to ${g.maxShots} generated shots to keep the cost down; the rest reuse them.`)
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
          label: `${section.label} · shot ${i + 1}`,
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
function sungSpans(input: PlannerInput): { start: Seconds; end: Seconds }[] {
  return (input.lyrics?.lines ?? []).flatMap((l) => {
    const start = l.start ?? l.words[0]?.start
    const end = l.end ?? l.words[l.words.length - 1]?.end
    return start !== undefined && end !== undefined && end > start ? [{ start, end }] : []
  })
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

function buildTexts(
  sections: SectionInfo[],
  briefs: Map<string, BriefSection>,
  ctx: Ctx,
  titleText: string,
): PlanText[] {
  const { input, brief } = ctx
  const texts: PlanText[] = []
  const aspect = input.settings.aspect
  const textBrief = brief.text
  const show = textBrief?.show ?? input.kind === 'lyric'
  const accent = textBrief?.accentColor ?? ctx.look?.accentColor ?? '#facc15'
  const baseSize = aspect === '16:9' ? 84 : aspect === '9:16' ? 76 : 80
  const lookStyle = ctx.look?.text?.style
  const lookUppercase =
    lookStyle?.textTransform === undefined ? undefined : lookStyle.textTransform === 'uppercase'
  const weight = lookStyle?.fontWeight ?? 700
  const backgroundBusy = ctx.visual === 'footage' || ctx.visual === 'stills' || ctx.visual === 'generated'
  // Footage can be as bright as the text; a thin dark outline keeps every word readable over white skies and walls.
  const stroke = lookStyle?.stroke ?? (backgroundBusy ? { color: '#000000b3', width: 4 } : undefined)
  const base: TextStyleSpec = {
    fontFamily: textBrief?.fontFamily ?? lookStyle?.fontFamily ?? 'Inter, system-ui, sans-serif',
    fontSize: baseSize,
    fontWeight: weight,
    ...(lookStyle?.letterSpacing !== undefined ? { letterSpacing: lookStyle.letterSpacing } : {}),
    color: textBrief?.color ?? ctx.look?.textColor ?? '#ffffff',
    align: 'center',
    maxWidth: aspect === '16:9' ? 0.8 : 0.86,
    shadow: lookStyle?.shadow ?? { color: '#000000b3', blur: 14, offsetX: 0, offsetY: 3 },
    ...(stroke ? { stroke } : {}),
  }
  const position = textBrief?.position ?? (backgroundBusy && input.kind !== 'lyric' ? 'lower' : 'center')
  const y = position === 'lower' ? 0.8 : position === 'upper' ? 0.2 : 0.5
  const sectionAt = (t: number) =>
    sections.find((s) => t >= s.start && t < s.end) ?? sections[sections.length - 1]
  const presetOf = (sb?: BriefSection) =>
    sb?.textPresetId ??
    findItem(input.catalog.textPresets, textBrief?.presetId)?.id ??
    findItem(input.catalog.textPresets, ctx.look?.text?.animation?.presetId)?.id
  const fade = transitionOf(ctx, 'fade', 0.15)

  const lines = input.lyrics?.lines.filter((l) => l.text.trim()) ?? []
  if (show && lines.length > 0) {
    const timed = timedLines(lines, sections, input.song.duration, ctx)
    const shown = displayTimes(timed, input.song.duration)
    for (const [i, item] of timed.entries()) {
      const { start, end } = shown[i] as { start: Seconds; end: Seconds }
      if (end <= start) continue
      const section = sectionAt(item.start)
      const sb = section ? briefs.get(section.id) : undefined
      const peak = !!section && isPeak(section) && (sb?.intensity ?? section.energy) >= 0.6
      const style: TextStyleSpec = peak
        ? {
            ...base,
            fontSize: Math.round(baseSize * 1.18),
            fontWeight: Math.min(900, weight + 100),
            uppercase: textBrief?.uppercase ?? lookUppercase ?? true,
          }
        : { ...base, uppercase: textBrief?.uppercase ?? lookUppercase ?? false }
      const timedWords = item.line.words.length > 0 && item.line.words.every((w) => w.end > w.start)
      const preset = presetOf(sb)
      texts.push({
        id: newId(),
        sectionId: section?.id,
        start: round3(start),
        end: round3(end),
        text: item.line.text,
        lyricLineId: item.line.id,
        style,
        position: { x: 0.5, y },
        ...(preset ? { animationPresetId: preset } : fade ? { transitionIn: fade, transitionOut: fade } : {}),
        ...(timedWords && textBrief?.karaoke !== false
          ? { karaoke: { highlightColor: accent, mode: 'word' as const } }
          : {}),
        ...(peak && (sb?.reactive ?? 0) >= 0.5
          ? {
              reactive: [{ target: 'scale' as const, source: 'beat' as const, amount: 0.03, smoothing: 0.3 }],
            }
          : {}),
        role: 'lyric',
      })
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
    const card: PlanText[] = [
      {
        id: newId(),
        sectionId: first.id,
        start: 0.5,
        end: round3(titleEnd),
        text: titleText,
        style: {
          ...base,
          fontSize: Math.round(baseSize * 1.3),
          fontWeight: Math.max(800, weight),
          letterSpacing: 0.12,
          uppercase: true,
        },
        position: { x: 0.5, y: artist ? 0.46 : 0.5 },
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
        style: {
          ...base,
          fontSize: Math.round(baseSize * 0.56),
          fontWeight: weight,
          letterSpacing: 0.3,
          uppercase: true,
        },
        position: { x: 0.5, y: 0.58 },
        ...fades,
        role: 'title',
      })
    }
    texts.unshift(...card)
  }
  return texts
}

function summarize(plan: Omit<EditPlan, 'summary'>, ctx: Ctx): string {
  const main = plan.shots.filter((s) => s.layer === 'main')
  const mediaIds = new Set(main.flatMap((s) => (s.source.type === 'media' ? [s.source.assetId] : [])))
  const toGenerate = plan.shots.filter((s) => s.source.type === 'generate' && !s.source.sameAs).length
  const lyricCount = plan.texts.filter((t) => t.role === 'lyric').length
  const parts = [`${KIND_NAME[plan.kind]} with ${plan.sections.length} sections`]
  if (ctx.visual === 'visualizer') parts.push('music-reactive visuals')
  else if (main.length) parts.push(`${main.length} shots`)
  if (mediaIds.size) parts.push(`${mediaIds.size} of your ${mediaIds.size === 1 ? 'clip' : 'clips'}`)
  if (toGenerate) parts.push(`${toGenerate} to generate`)
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
      "Song analysis isn't finished, so cuts follow an even tempo grid. Run the director again when beats and sections are ready.",
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
    concept: brief.concept.trim() || input.prompt || DEFAULT_CONCEPT[input.kind],
    promptStyle: brief.promptStyle ?? preset?.promptStyle ?? '',
    pending: [],
    shotIndex: 0,
    generated: [],
    groupShots: new Map(),
    motionOffset: Math.floor(rng() * IMAGE_MOTIONS.length),
    promptOffset: Math.floor(rng() * 6),
    energyAt: energyScale(input.song),
    sung: sungSpans(input),
  }
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
  shots = openAndClose(await chooseFootage(shots, ctx), ctx)
  const titleText = input.song.title ?? (meta.planner === 'llm' ? brief.title.trim() : '')
  const texts = buildTexts(sections, briefs, ctx, titleText)
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
