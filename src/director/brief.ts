/**
 * The creative brief: the high-level choices a planner makes per section (mood, pace, look, media, prompts).
 * The local planner derives one from rules; the LLM planner asks the model for one. expandBrief() then turns
 * either into an exact, beat-aligned EditPlan, so an LLM never has to compute timings.
 */
import { z } from 'zod'
import { adjustmentsSchema, MOTIONS, PACES } from './plan.ts'

export const briefSectionSchema = z.object({
  sectionId: z.string().describe('id of a song section from the brief input'),
  mood: z.string().max(80).describe('two or three words, e.g. "tense, building"'),
  intensity: z.number().min(0).max(1).describe('visual intensity, 0 calm to 1 peak'),
  pace: z
    .enum(PACES)
    .describe(
      'how often to cut: very-fast every beat, fast every 2 beats, medium every bar, slow 2 bars, very-slow 4 bars',
    ),
  transition: z
    .string()
    .optional()
    .describe('transition id into this section, from the catalog; omit for a hard cut'),
  effects: z.array(z.string()).max(3).optional().describe('effect ids from the catalog'),
  reactive: z.number().min(0).max(1).optional().describe('how strongly visuals pulse with the music, 0 to 1'),
  mediaQuery: z
    .string()
    .max(200)
    .optional()
    .describe('words describing footage to look for in the user media'),
  assetIds: z.array(z.string()).max(12).optional().describe('preferred user media ids for this section'),
  prompts: z
    .array(z.string().max(400))
    .max(8)
    .optional()
    .describe('image or video generation prompts for this section, one per shot idea'),
  generatorId: z.string().optional().describe('visualizer id from the catalog'),
  textPresetId: z.string().optional().describe('text animation preset id from the catalog'),
  motion: z.enum(MOTIONS).optional().describe('camera move for stills'),
})

export const briefSchema = z.object({
  title: z.string().max(80).describe('short title for the video'),
  concept: z.string().max(500).describe('one or two sentences describing the creative idea'),
  lookId: z.string().optional().describe('look id from the catalog'),
  adjustments: adjustmentsSchema.optional().describe('extra color adjustments, each -1 to 1'),
  visual: z
    .enum(['footage', 'stills', 'generated', 'visualizer'])
    .describe(
      'main visual source: the user footage, still images, AI-generated shots, or a music visualizer',
    ),
  promptStyle: z.string().max(200).optional().describe('style words appended to every generation prompt'),
  text: z
    .object({
      show: z.boolean().describe('show lyrics as text'),
      fontFamily: z.string().optional(),
      color: z.string().optional().describe('hex color'),
      accentColor: z.string().optional().describe('hex color for highlights'),
      uppercase: z.boolean().optional(),
      presetId: z.string().optional().describe('text animation preset id from the catalog'),
      position: z.enum(['center', 'lower', 'upper']).optional(),
      karaoke: z.boolean().optional().describe('highlight each word as it is sung'),
    })
    .optional(),
  sections: z.array(briefSectionSchema),
})

export type BriefSection = z.infer<typeof briefSectionSchema>
export type CreativeBrief = z.infer<typeof briefSchema>
