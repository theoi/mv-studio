/**
 * Export choices saved with the project in project.extensions.export: framing overrides per format and clip, and
 * the export dialog's outputs list. Written with project.setExtension, so every change is undoable.
 */
import { z } from 'zod'
import type { EditCommand } from '../model/commands.ts'
import type { AspectPreset, Id, JsonValue, Project } from '../model/types.ts'
import type { FramingOverride } from './formats.ts'
import type { OutputSpec } from './types.ts'

export const EXPORT_EXTENSION_KEY = 'export'

export interface ExportPreferences {
  version: 1
  framing: Partial<Record<AspectPreset, Record<Id, FramingOverride>>>
  outputs?: OutputSpec[]
}

const aspect = z.enum(['16:9', '9:16', '1:1', '4:5'])
const mode = z.enum(['auto', 'fill', 'fit'])
const override = z.object({
  mode: mode.optional(),
  offsetX: z.number().min(-2).max(2).optional(),
  offsetY: z.number().min(-2).max(2).optional(),
  zoom: z.number().min(0.25).max(8).optional(),
})
const range = z.object({ start: z.number().min(0), end: z.number().min(0) }).refine((r) => r.end > r.start)
const output = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'teaser', 'loop']),
  name: z.string(),
  aspect,
  resolution: z.enum(['720p', '1080p', '1440p', '2160p']),
  fps: z.number().positive().max(120),
  quality: z.enum(['high', 'balanced', 'small']),
  reframe: mode,
  range: range.optional(),
  audio: z.boolean().optional(),
})
const preferences = z.object({
  version: z.literal(1),
  framing: z.partialRecord(aspect, z.record(z.string(), override)).default({}),
  outputs: z.array(output).optional(),
})

const EMPTY: ExportPreferences = { version: 1, framing: {} }

/** The saved export choices; defaults when there are none or they cannot be read. */
export function exportPreferences(project: Project): ExportPreferences {
  const parsed = preferences.safeParse(project.extensions?.[EXPORT_EXTENSION_KEY])
  return parsed.success ? (parsed.data as ExportPreferences) : EMPTY
}

/** Framing overrides of a format by clip id, for clips that still exist. */
export function framingOverrides(project: Project, format: AspectPreset): Record<Id, FramingOverride> {
  const all = exportPreferences(project).framing[format] ?? {}
  return Object.fromEntries(Object.entries(all).filter(([id]) => project.clips[id]))
}

function write(project: Project, prefs: ExportPreferences): EditCommand {
  const framing: ExportPreferences['framing'] = {}
  for (const [format, byClip] of Object.entries(prefs.framing) as [
    AspectPreset,
    Record<Id, FramingOverride>,
  ][]) {
    const kept = Object.fromEntries(Object.entries(byClip).filter(([id]) => project.clips[id]))
    if (Object.keys(kept).length > 0) framing[format] = kept
  }
  const value: ExportPreferences = { ...prefs, framing }
  const empty = Object.keys(framing).length === 0 && !value.outputs
  return {
    type: 'project.setExtension',
    key: EXPORT_EXTENSION_KEY,
    value: empty ? null : (JSON.parse(JSON.stringify(value)) as JsonValue),
  }
}

/** Sets (or with null clears) the framing of one clip in one format. Overrides of deleted clips are dropped. */
export function setFramingCommand(
  project: Project,
  format: AspectPreset,
  clipId: Id,
  framing: FramingOverride | null,
): EditCommand {
  const prefs = exportPreferences(project)
  const byClip = { ...prefs.framing[format] }
  if (framing && Object.keys(framing).length > 0) byClip[clipId] = framing
  else delete byClip[clipId]
  return write(project, { ...prefs, framing: { ...prefs.framing, [format]: byClip } })
}

/** Saves the export dialog's outputs list with the project. */
export function setOutputsCommand(project: Project, outputs: OutputSpec[] | null): EditCommand {
  const { outputs: _previous, ...prefs } = exportPreferences(project)
  return write(project, outputs ? { ...prefs, outputs } : prefs)
}
