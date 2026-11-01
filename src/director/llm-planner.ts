/**
 * The LLM planner: asks the user's OpenAI-compatible model for a creative brief (moods, look, footage queries and
 * generation prompts per section), then expands it with expandBrief(), so the model never has to compute timings.
 * The model sees short ids (s1, m1) instead of UUIDs. When the model can't be reached or its answer can't be used,
 * the local planner makes the draft and the plan says why.
 */
import { z } from 'zod'
import { cloudErrorInfo } from '../cloud/errors.ts'
import type { ChatMessage, ToolCallRequest, ToolCallResult, ToolDefinition } from '../cloud/llm/client.ts'
import { JobError, type JobContext } from '../shared/jobs.ts'
import { briefSchema, type BriefSection, type CreativeBrief } from './brief.ts'
import { expandBrief } from './expand.ts'
import type { PlannerInput } from './inputs.ts'
import { ruleBrief } from './local-planner.ts'
import { COLOR_KEYS, MOTIONS, PACES, type EditPlan, type Pace } from './plan.ts'
import { linesIn, SURE_LABEL } from './rules.ts'
import { beatGrid, sectionsFor } from './timing.ts'

/** The part of OpenAICompatibleClient the director uses. */
export interface LlmToolClient {
  callTools(request: ToolCallRequest): Promise<ToolCallResult>
}

export interface LlmPlannerOptions {
  /** The configured client, e.g. () => cloud.llm(); undefined means no LLM is set up. */
  client: () => LlmToolClient | undefined
  /** Model name recorded in the plan. */
  model?: () => string | undefined
}

const BRIEF_TOOL = 'make_brief'

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

export const BRIEF_TOOL_DEFINITION: ToolDefinition = {
  name: BRIEF_TOOL,
  description: 'Submit the creative brief for the music video: overall look and one entry per song section.',
  parameters: jsonSchema(briefSchema),
}

interface BriefIds {
  sections: Map<string, string>
  media: Map<string, string>
}

const r2 = (n: number) => Math.round(n * 100) / 100

const KIND_GUIDE: Record<PlannerInput['kind'], string> = {
  lyric:
    'A lyric video: the lyrics are the star. Set text.show to true, keep backgrounds calm enough to read the text, and cut slowly.',
  visualizer:
    'A visualizer: set visual to "visualizer", pick a visualizer per section, and make high-energy sections strongly reactive.',
  'beat-cut':
    'A beat-cut video: cut the user footage to the beat, faster and more intense in high-energy sections.',
  ai: 'An AI music video: tell a simple visual story with one consistent main subject and setting across all sections.',
}

/** The brief request the model sees, with short ids, plus the map back to real ids. */
export function briefRequest(input: PlannerInput): { payload: Record<string, unknown>; ids: BriefIds } {
  const grid = beatGrid(input.song)
  const sections = sectionsFor(input.song, grid)
  const ids: BriefIds = { sections: new Map(), media: new Map() }
  const media = input.useMedia ? input.media.slice(0, 40) : []
  const payload = {
    kind: input.kind,
    userPrompt: input.prompt || null,
    aspect: input.settings.aspect,
    song: {
      duration: r2(input.song.duration),
      bpm: Math.round(grid.bpm),
      analyzed: input.song.analyzed,
      sections: sections.map((s, i) => {
        const id = `s${i + 1}`
        ids.sections.set(id, s.id)
        const lyrics = linesIn(input.lyrics, s.start, s.end)
          .slice(0, 2)
          .map((l) => l.text.slice(0, 100))
        return {
          id,
          label: s.label,
          ...((s.confidence ?? 1) < SURE_LABEL ? { labelGuessed: true } : {}),
          start: r2(s.start),
          end: r2(s.end),
          energy: r2(s.energy),
          ...(lyrics.length ? { lyrics } : {}),
        }
      }),
    },
    hasLyrics: (input.lyrics?.lines.length ?? 0) > 0,
    media: media.map((m, i) => {
      const id = `m${i + 1}`
      ids.media.set(id, m.assetId)
      return {
        id,
        kind: m.kind,
        name: m.name,
        ...(m.duration ? { duration: r2(m.duration) } : {}),
        ...(m.info?.labels?.length ? { labels: m.info.labels.slice(0, 6) } : {}),
        ...(m.info?.motion !== undefined ? { motion: r2(m.info.motion) } : {}),
        ...(m.info?.mood?.length ? { mood: m.info.mood.slice(0, 3) } : {}),
      }
    }),
    generation: input.generation
      ? { mode: input.generation.mode, maxDistinctPrompts: input.generation.maxShots }
      : null,
    catalog: {
      looks: input.catalog.looks.map((l) => ({ id: l.id, name: l.name, tags: l.tags })),
      effects: input.catalog.effects.map((e) => ({ id: e.id, name: e.name, tags: e.tags })),
      transitions: input.catalog.transitions.map((t) => ({ id: t.id, name: t.name })),
      visualizers: input.catalog.generators.map((g) => ({ id: g.id, name: g.name, tags: g.tags })),
      textPresets: input.catalog.textPresets.map((t) => ({ id: t.id, name: t.name })),
    },
  }
  return { payload, ids }
}

export function briefMessages(input: PlannerInput, payload: Record<string, unknown>): ChatMessage[] {
  const system = [
    'You are the director in MV Studio, a music-video editor. Plan the video described in the user message by',
    `calling ${BRIEF_TOOL} exactly once.`,
    KIND_GUIDE[input.kind],
    'Rules:',
    '- Give one sections entry for every song section, using its id (s1, s2, ...).',
    '- Use only ids listed in catalog and media. Leave a field out rather than invent an id.',
    '- visual: "footage" or "stills" only when media is listed, "generated" only when generation is not null, otherwise "visualizer".',
    '- Follow the energy: quiet sections get a slower pace, lower intensity and soft transitions; choruses and drops get faster cuts, higher intensity and stronger reactivity.',
    '- Repeated sections (same label) should feel related.',
    '- A label with labelGuessed was guessed from the audio alone: when its energy disagrees, follow the energy.',
    '- Generation prompts describe one concrete image each: subject, setting, action, camera and light. Keep the same main subject and style throughout. No text, logos or real people.',
    '- Follow the user prompt as the creative direction when there is one.',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

const PACE_ALIASES: Record<string, Pace> = {
  'very slow': 'very-slow',
  slowest: 'very-slow',
  slow: 'slow',
  medium: 'medium',
  moderate: 'medium',
  normal: 'medium',
  fast: 'fast',
  quick: 'fast',
  'very fast': 'very-fast',
  fastest: 'very-fast',
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
const num01 = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined
const strings = (v: unknown, max: number, each: number) =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, each))
        .filter((x): x is string => !!x)
        .slice(0, max)
    : undefined

function pace(v: unknown): Pace | undefined {
  if (typeof v !== 'string') return undefined
  const key = v.trim().toLowerCase()
  return (PACES as readonly string[]).includes(key) ? (key as Pace) : PACE_ALIASES[key.replace(/-/g, ' ')]
}

function defined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

/**
 * Coerces a model's brief into the schema: trims long strings, clamps numbers, maps short ids back and drops what
 * can't be used, so one sloppy field doesn't throw the whole answer away. Missing parts fall back to `rules`.
 */
export function normalizeBrief(raw: unknown, ids: BriefIds, rules: CreativeBrief): CreativeBrief | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const ruleSections = new Map(rules.sections.map((s) => [s.sectionId, s]))
  const rawSections = Array.isArray(r.sections) ? r.sections : []
  const sections: BriefSection[] = []
  for (const [i, item] of rawSections.entries()) {
    if (typeof item !== 'object' || item === null) continue
    const s = item as Record<string, unknown>
    const short = str(s.sectionId, 40) ?? str(s.id, 40)
    const sectionId =
      (short && ids.sections.get(short)) ??
      (rawSections.length === ids.sections.size ? ids.sections.get(`s${i + 1}`) : undefined)
    if (!sectionId || sections.some((x) => x.sectionId === sectionId)) continue
    const base = ruleSections.get(sectionId)
    const motion = str(s.motion, 20)
    const section = defined({
      sectionId,
      mood: str(s.mood, 80) ?? base?.mood ?? '',
      intensity: num01(s.intensity) ?? base?.intensity ?? 0.5,
      pace: pace(s.pace) ?? base?.pace ?? 'medium',
      transition: str(s.transition, 40),
      effects: strings(s.effects, 3, 40),
      reactive: num01(s.reactive),
      mediaQuery: str(s.mediaQuery, 200),
      assetIds: strings(s.assetIds, 12, 40)
        ?.map((id) => ids.media.get(id))
        .filter((id): id is string => !!id),
      prompts: strings(s.prompts, 8, 400),
      generatorId: str(s.generatorId, 60),
      textPresetId: str(s.textPresetId, 60),
      motion:
        motion && (MOTIONS as readonly string[]).includes(motion)
          ? (motion as BriefSection['motion'])
          : undefined,
    }) as BriefSection
    sections.push(section)
  }
  const visual = str(r.visual, 20)
  const adjustments =
    typeof r.adjustments === 'object' && r.adjustments !== null
      ? Object.fromEntries(
          Object.entries(r.adjustments as Record<string, unknown>)
            .filter(
              ([k, v]) =>
                (COLOR_KEYS as readonly string[]).includes(k) && typeof v === 'number' && Number.isFinite(v),
            )
            .map(([k, v]) => [k, Math.max(-1, Math.min(1, v as number))]),
        )
      : undefined
  const t = typeof r.text === 'object' && r.text !== null ? (r.text as Record<string, unknown>) : undefined
  const position = str(t?.position, 10)
  const brief = defined({
    title: str(r.title, 80) ?? rules.title,
    concept: str(r.concept, 500) ?? rules.concept,
    lookId: str(r.lookId, 40),
    adjustments: adjustments && Object.keys(adjustments).length ? adjustments : undefined,
    visual:
      visual && ['footage', 'stills', 'generated', 'visualizer'].includes(visual)
        ? (visual as CreativeBrief['visual'])
        : rules.visual,
    promptStyle: str(r.promptStyle, 200),
    text: t
      ? defined({
          show: typeof t.show === 'boolean' ? t.show : (rules.text?.show ?? false),
          fontFamily: str(t.fontFamily, 80),
          color: str(t.color, 9),
          accentColor: str(t.accentColor, 9),
          uppercase: typeof t.uppercase === 'boolean' ? t.uppercase : undefined,
          presetId: str(t.presetId, 60),
          position:
            position && ['center', 'lower', 'upper'].includes(position) ? (position as 'center') : undefined,
          karaoke: typeof t.karaoke === 'boolean' ? t.karaoke : undefined,
        })
      : rules.text,
    sections,
  }) as CreativeBrief
  const parsed = briefSchema.safeParse(brief)
  return parsed.success ? parsed.data : undefined
}

function usable(brief: CreativeBrief | undefined, sectionCount: number): brief is CreativeBrief {
  return !!brief && brief.sections.length >= Math.ceil(sectionCount / 2)
}

async function askForBrief(
  client: LlmToolClient,
  input: PlannerInput,
  ctx: JobContext,
): Promise<CreativeBrief | undefined> {
  const { payload, ids } = briefRequest(input)
  const rules = ruleBrief(input)
  const messages = briefMessages(input, payload)
  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.progress({
      stage: 'llm',
      fraction: attempt === 0 ? 0.4 : 0.6,
      message: attempt === 0 ? 'Asking your AI model for ideas' : 'Asking again',
    })
    const result = await client.callTools({
      messages,
      tools: [BRIEF_TOOL_DEFINITION],
      toolChoice: { name: BRIEF_TOOL },
      temperature: 0.7,
      maxTokens: 4000,
      signal: ctx.signal,
    })
    ctx.throwIfCancelled()
    const call = result.calls.find((c) => c.name === BRIEF_TOOL)
    const brief = call && !call.error ? normalizeBrief(call.args, ids, rules) : undefined
    if (usable(brief, ids.sections.size)) return brief
    if (attempt > 0) break
    messages.push(result.assistant)
    const problem =
      call?.error ?? (brief ? 'Most song sections are missing.' : 'The brief did not match the schema.')
    messages.push(
      call
        ? {
            role: 'tool',
            tool_call_id: call.id,
            content: `Not usable: ${problem} Call ${BRIEF_TOOL} again with every section.`,
          }
        : { role: 'user', content: `Call ${BRIEF_TOOL} with the full brief.` },
    )
  }
  return undefined
}

/** Plans with the LLM when one is configured, otherwise (or when it fails) with the local planner. */
export function createDirectorPlanner(options: LlmPlannerOptions) {
  return async (input: PlannerInput, ctx: JobContext): Promise<EditPlan> => {
    const client = options.client()
    if (!client) return expandBrief(ruleBrief(input), input, { planner: 'local' })
    let reason: string
    try {
      const brief = await askForBrief(client, input, ctx)
      if (brief) return await expandBrief(brief, input, { planner: 'llm', model: options.model?.() })
      reason = "Your AI model's answer couldn't be used, so the built-in planner made this draft."
    } catch (error) {
      const err = JobError.from(error)
      if (err.code === 'cancelled' || ctx.signal.aborted) throw err
      if (err.details && typeof err.details === 'object' && 'director' in err.details) throw err
      const cloud = cloudErrorInfo(err)
      reason = `Your AI model couldn't help (${cloud?.title ?? err.message}), so the built-in planner made this draft.`
      if (cloud?.action) reason += ` ${cloud.action}, then draft again.`
    }
    const plan = await expandBrief(ruleBrief(input), input, { planner: 'local' })
    return { ...plan, warnings: [reason, ...plan.warnings] }
  }
}
