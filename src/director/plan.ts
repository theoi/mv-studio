/**
 * The edit plan: a complete, serializable description of a draft video (shots, text, effects, transitions,
 * audio-reactive bindings and a look). Planners produce it; compilePlan() turns it into ordinary EditCommands, so
 * everything the director makes stays normal, editable project content.
 */
import { z } from 'zod'
import type { ReactionId } from '../plugins/reactions.ts'

export const COLOR_KEYS = [
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'hue',
] as const
export const PACES = ['very-slow', 'slow', 'medium', 'fast', 'very-fast'] as const
export const MOTIONS = [
  'none',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'drift-up',
  'drift-down',
] as const
export const AUDIO_SOURCES = ['loudness', 'bass', 'mid', 'treble', 'onset', 'beat', 'downbeat'] as const
export const BINDING_TARGETS = ['scale', 'opacity', 'rotation', 'x', 'y', ...COLOR_KEYS] as const
/** Music reactions from src/plugins/reactions.ts ("Pulse with kick"), so the inspector shows them by name. */
export const REACTION_IDS = [
  'kick',
  'snare',
  'hats',
  'bass',
  'vocals',
  'loudness',
  'beat',
  'downbeat',
] as const satisfies readonly ReactionId[]
/** Bottom to top: shots, overlays (visualizers over footage or scenes), accents (particles on choruses). */
export const SHOT_LAYERS = ['main', 'overlay', 'accent'] as const

const seconds = z.number().finite().min(0)
const paramValue = z.union([z.number(), z.string(), z.boolean()])

export const adjustmentsSchema = z.partialRecord(z.enum(COLOR_KEYS), z.number().min(-1).max(1))

export const audioBindingSchema = z.object({
  target: z.enum(BINDING_TARGETS),
  source: z.enum(AUDIO_SOURCES),
  stem: z.enum(['vocals', 'drums', 'bass', 'other']).optional(),
  amount: z.number().min(-2).max(2),
  smoothing: z.number().min(0).max(1).optional(),
  mode: z.enum(['add', 'multiply']).optional(),
})

export const effectSpecSchema = z.object({
  effectId: z.string().min(1),
  params: z.record(z.string(), paramValue).optional(),
  react: z
    .array(
      z.object({
        param: z.string().min(1),
        source: z.enum(AUDIO_SOURCES),
        stem: z.enum(['vocals', 'drums', 'bass', 'other']).optional(),
        amount: z.number().min(-2).max(2),
        smoothing: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
})

/** A music reaction on a clip property or on a param of the shot's generator, at 0..1 of its full amount. */
export const reactionSpecSchema = z.object({
  reaction: z.enum(REACTION_IDS),
  target: z.union([
    z.object({ property: z.enum(['scale', 'opacity', 'rotation', 'x', 'y']) }),
    z.object({ param: z.string().min(1) }),
  ]),
  amount: z.number().min(0).max(1),
})

export const transitionSpecSchema = z.object({
  kind: z.string().min(1),
  duration: z.number().min(0.02).max(4),
})

export const shotSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('media'),
    assetId: z.string().min(1),
    sourceStart: seconds.optional(),
    playbackRate: z.number().min(0.25).max(4).optional(),
  }),
  z.object({
    type: z.literal('generate'),
    task: z.enum(['text-to-image', 'text-to-video', 'image-to-video']),
    prompt: z.string().min(1),
    modelId: z.string().min(1),
    duration: z.number().positive().optional(),
    /** image-to-video: the still to animate. */
    imageAssetId: z.string().optional(),
    /** Reuse the result generated for another shot (repeated choruses), at no extra cost. */
    sameAs: z.string().optional(),
  }),
  z.object({
    type: z.literal('generator'),
    generatorId: z.string().min(1),
    params: z.record(z.string(), paramValue).optional(),
  }),
  z.object({ type: z.literal('solid'), color: z.string() }),
])

export const shotSchema = z
  .object({
    id: z.string().min(1),
    sectionId: z.string().optional(),
    start: seconds,
    end: seconds,
    layer: z.enum(SHOT_LAYERS),
    source: shotSourceSchema,
    fit: z.enum(['cover', 'contain']).optional(),
    motion: z.enum(MOTIONS).optional(),
    transitionIn: transitionSpecSchema.optional(),
    /** Out to nothing (black), for the end of the video. */
    transitionOut: transitionSpecSchema.optional(),
    effects: z.array(effectSpecSchema).optional(),
    reactive: z.array(audioBindingSchema).optional(),
    reactions: z.array(reactionSpecSchema).optional(),
    adjustments: adjustmentsSchema.optional(),
    opacity: z.number().min(0).max(1).optional(),
    blendMode: z.enum(['normal', 'screen', 'add', 'overlay', 'multiply', 'soft-light']).optional(),
    label: z.string().optional(),
  })
  .refine((s) => s.end > s.start, { message: 'Shot must end after it starts' })

export const textStyleSpecSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().min(8).max(400).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  italic: z.boolean().optional(),
  color: z.string().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  uppercase: z.boolean().optional(),
  /** Wins over `uppercase`, for styles set in lowercase. */
  textTransform: z.enum(['none', 'uppercase', 'lowercase']).optional(),
  letterSpacing: z.number().optional(),
  lineHeight: z.number().min(0.5).max(3).optional(),
  maxWidth: z.number().min(0.1).max(1).optional(),
  stroke: z.object({ color: z.string(), width: z.number().min(0) }).optional(),
  shadow: z
    .object({ color: z.string(), blur: z.number(), offsetX: z.number(), offsetY: z.number() })
    .optional(),
  background: z.object({ color: z.string(), padding: z.number(), radius: z.number() }).optional(),
})

export const textItemSchema = z
  .object({
    id: z.string().min(1),
    sectionId: z.string().optional(),
    start: seconds,
    end: seconds,
    text: z.string().min(1),
    lyricLineId: z.string().optional(),
    style: textStyleSpecSchema,
    position: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    animationPresetId: z.string().optional(),
    karaoke: z.object({ highlightColor: z.string(), mode: z.enum(['word', 'line']) }).optional(),
    reactive: z.array(audioBindingSchema).optional(),
    transitionIn: transitionSpecSchema.optional(),
    transitionOut: transitionSpecSchema.optional(),
    /**
     * 'emphasis': the stressed word of a lyric line, shown bigger below the rest of the line as it is sung.
     * 'preview': the next lyric line, waiting smaller and dimmer below the current one in fast passages.
     * Neither is linked to the line for karaoke; `lyricLineId` still names it.
     */
    role: z.enum(['lyric', 'title', 'emphasis', 'preview']).optional(),
    /** Title cards: the font size the text was laid out from, before any shrinking to fit. */
    baseFontSize: z.number().min(8).max(400).optional(),
    opacity: z.number().min(0).max(1).optional(),
    scale: z.number().min(0.1).max(4).optional(),
    /** Enters from this position, scale and opacity over `duration` (a preview line rolling up into place). */
    enter: z
      .object({
        y: z.number().optional(),
        scale: z.number().min(0.1).max(4).optional(),
        opacity: z.number().min(0).max(1).optional(),
        duration: z.number().min(0.02).max(2),
      })
      .optional(),
    /** Lyrics behind the subject: the text shows only outside this subject mask of the footage under it. */
    behind: z.object({ maskAssetId: z.string().min(1), sourceAssetId: z.string().min(1) }).optional(),
  })
  .refine((t) => t.end > t.start, { message: 'Text must end after it starts' })

export const lookSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  adjustments: adjustmentsSchema,
  effects: z.array(effectSpecSchema),
})

export const planSectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  start: seconds,
  end: seconds,
  energy: z.number().min(0).max(1),
  mood: z.string(),
  pace: z.enum(PACES),
})

export const editPlanSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  kind: z.enum(['lyric', 'visualizer', 'beat-cut', 'ai']),
  title: z.string(),
  summary: z.string(),
  concept: z.string(),
  prompt: z.string(),
  planner: z.enum(['local', 'llm']),
  /** LLM model that wrote the creative brief. */
  model: z.string().optional(),
  seed: z.number().int(),
  aspect: z.enum(['16:9', '9:16', '1:1', '4:5']),
  duration: seconds,
  songAssetId: z.string().optional(),
  sections: z.array(planSectionSchema),
  shots: z.array(shotSchema),
  texts: z.array(textItemSchema),
  look: lookSchema.optional(),
  warnings: z.array(z.string()),
})

export type ColorKey = (typeof COLOR_KEYS)[number]
export type Pace = (typeof PACES)[number]
export type Motion = (typeof MOTIONS)[number]
export type AudioBinding = z.infer<typeof audioBindingSchema>
export type EffectSpec = z.infer<typeof effectSpecSchema>
export type TransitionSpec = z.infer<typeof transitionSpecSchema>
export type ReactionSpec = z.infer<typeof reactionSpecSchema>
export type ShotLayer = (typeof SHOT_LAYERS)[number]
export type ShotSource = z.infer<typeof shotSourceSchema>
export type GenerateSource = Extract<ShotSource, { type: 'generate' }>
export type PlanShot = z.infer<typeof shotSchema>
export type TextStyleSpec = z.infer<typeof textStyleSpecSchema>
export type PlanText = z.infer<typeof textItemSchema>
export type PlanLook = z.infer<typeof lookSchema>
export type PlanSection = z.infer<typeof planSectionSchema>
export type EditPlan = z.infer<typeof editPlanSchema>

/** Validates a plan from storage or another source. Throws a readable error listing the first problems. */
export function parseEditPlan(input: unknown): EditPlan {
  const result = editPlanSchema.safeParse(input)
  if (result.success) return result.data
  const issues = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`)
    .join('; ')
  throw new Error(`Invalid edit plan: ${issues}`)
}

/** What the plan's AI shots are called: "clip" when every one of them is a video, else "shot". */
export function generatedUnit(plan: Pick<EditPlan, 'shots'>): 'shot' | 'clip' {
  const generated = plan.shots.filter((s) => s.source.type === 'generate')
  return generated.length > 0 &&
    generated.every((s) => s.source.type === 'generate' && s.source.task !== 'text-to-image')
    ? 'clip'
    : 'shot'
}

/** Shots that need a paid generation (not reusing another shot's result). */
export function shotsToGenerate(plan: Pick<EditPlan, 'shots'>): (PlanShot & { source: GenerateSource })[] {
  return plan.shots.filter(
    (s): s is PlanShot & { source: GenerateSource } => s.source.type === 'generate' && !s.source.sameAs,
  )
}
