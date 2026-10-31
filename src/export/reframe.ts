/**
 * Reframing the project itself after its aspect ratio changes (Preview › aspect ratio › "Reframe automatically",
 * and Inspector › Framing on a reframed clip): clips are laid out for the new frame as an export to that format
 * would lay them out (see ./formats.ts), through edit commands.
 *
 * A reframed clip remembers the layout it had before (meta.reframe), so reframing again starts from that layout
 * instead of from the last crop: 16:9 to 9:16 and back gives the original clip, not a zoomed-in one. A clip edited
 * by hand since its last reframe starts from its new layout.
 */
import { z } from 'zod'
import type { EditCommand } from '../model/commands.ts'
import type { Id, JsonObject, JsonValue, Project, ProjectSettings, VisualClip } from '../model/types.ts'
import { convertToFormat, type ClipFraming, type FormatOptions } from './formats.ts'

export type FrameSize = Pick<ProjectSettings, 'aspect' | 'width' | 'height'>

/** The clip fields a format conversion changes. */
const LAYOUT_KEYS = ['fit', 'transform', 'style'] as const

const remembered = z.object({
  aspect: z.enum(['16:9', '9:16', '1:1', '4:5']),
  width: z.number().positive(),
  height: z.number().positive(),
  layout: z.record(z.string(), z.json()),
  /** Fingerprint of the layout the reframe produced: when the clip no longer has it, it was edited by hand. */
  result: z.string(),
})
type Remembered = z.infer<typeof remembered>

function layoutOf(clip: VisualClip): JsonObject {
  const out: JsonObject = {}
  for (const key of LAYOUT_KEYS) {
    const value: unknown = Reflect.get(clip, key)
    if (value !== undefined) out[key] = JSON.parse(JSON.stringify(value)) as JsonValue
  }
  return out
}

function fingerprint(layout: JsonObject): string {
  const s = JSON.stringify(layout)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return `${s.length.toString(36)}.${(h >>> 0).toString(36)}`
}

/** The layout a clip was reframed from, while it still shows that reframe. */
function memoryOf(clip: VisualClip): Remembered | null {
  const parsed = remembered.safeParse(clip.meta?.reframe)
  return parsed.success && parsed.data.result === fingerprint(layoutOf(clip)) ? parsed.data : null
}

/** The aspect ratio a clip was automatically reframed from, while it still shows that reframe. */
export function reframedFrom(clip: VisualClip): FrameSize | null {
  const memory = memoryOf(clip)
  return memory && { aspect: memory.aspect, width: memory.width, height: memory.height }
}

export interface ProjectReframe {
  /** Layout changes, and what each clip remembers of the frame it came from. */
  commands: EditCommand[]
  /** What happened to each clip whose layout changed. */
  changed: Record<Id, ClipFraming>
  /** Footage framed without subject analysis (its center), changed or not. */
  centred: Id[]
  /** Clips that would change but sit on locked tracks, left as they are. */
  locked: Id[]
}

/**
 * Edit commands that lay the clips out for the project's aspect ratio, from the frame `from` they were laid out for
 * (the settings before the change), or from the layout a clip remembers. `clipIds` limits it to some clips.
 */
export function reframeCommands(
  project: Project,
  from: FrameSize,
  options: FormatOptions & { clipIds?: readonly Id[] } = {},
): ProjectReframe {
  const target = project.settings
  const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id))
  const groups = new Map<string, { size: FrameSize; clips: Project['clips'] }>()
  const memories = new Map<Id, Remembered>()
  for (const clip of Object.values(project.clips)) {
    if (clip.type === 'audio' || (options.clipIds && !options.clipIds.includes(clip.id))) continue
    const memory = memoryOf(clip)
    if (memory) memories.set(clip.id, memory)
    const size: FrameSize = memory ?? from
    const key = `${size.aspect}|${size.width}|${size.height}`
    const group = groups.get(key) ?? {
      size: { aspect: size.aspect, width: size.width, height: size.height },
      clips: {},
    }
    // Spreading a layout taken from this same clip keeps its type.
    group.clips[clip.id] = memory ? ({ ...clip, ...memory.layout } as VisualClip) : clip
    groups.set(key, group)
  }

  const result: ProjectReframe = { commands: [], changed: {}, centred: [], locked: [] }
  for (const { size, clips } of groups.values()) {
    const source: Project = { ...project, settings: { ...project.settings, ...size }, clips }
    const conversion = convertToFormat(source, target.aspect, options)
    const back = size.aspect === target.aspect
    for (const [id, converted] of Object.entries(conversion.project.clips)) {
      const clip = project.clips[id]
      if (!clip || clip.type === 'audio' || converted.type === 'audio') continue
      const locked = lockedTracks.has(clip.trackId)
      if (conversion.clips[id] === 'centred' && !locked) result.centred.push(id)
      const now = layoutOf(clip)
      const next = layoutOf(converted)
      const same = JSON.stringify(next) === JSON.stringify(now)
      const memory = memories.get(id)
      // A clip that already fits the new frame still remembers the old one, so a later Inspector › Framing choice
      // can reframe it.
      if (same && (back ? !memory : memory)) continue
      if (locked) {
        if (!same) result.locked.push(id)
        continue
      }
      for (const key of LAYOUT_KEYS)
        if (key in next && JSON.stringify(next[key]) !== JSON.stringify(now[key]))
          result.commands.push({ type: 'clip.set', clipId: id, path: [key], value: next[key] })
      const { reframe: _previous, ...meta } = clip.meta ?? {}
      const reframe: Remembered = {
        aspect: memory?.aspect ?? from.aspect,
        width: memory?.width ?? from.width,
        height: memory?.height ?? from.height,
        layout: memory?.layout ?? now,
        result: fingerprint(next),
      }
      result.commands.push({
        type: 'clip.set',
        clipId: id,
        path: ['meta'],
        value: back ? meta : { ...meta, reframe },
      })
      if (!same) result.changed[id] = conversion.clips[id] ?? 'unchanged'
    }
  }
  return result
}
