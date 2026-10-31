/**
 * Operations for plain-language edits: a small, friendly vocabulary an LLM can use reliably (set, animate, react,
 * move, add_text, add_effect, ...), validated with zod and compiled to ordinary EditCommands. Each operation is
 * tried on a scratch editor in order, so later operations see earlier results (new clips get ids n1, n2, ...)
 * and an invalid one is reported with its index instead of half-applying.
 */
import { z } from 'zod'
import { EditError, type EditCommand } from '../model/commands.ts'
import { ProjectEditor } from '../model/editor.ts'
import { ASPECT_PRESETS, createTextClip, createTrack, defaultTransform, newId } from '../model/factory.ts'
import type {
  Animatable,
  BlendMode,
  Clip,
  GeneratorClip,
  Id,
  ParamValue,
  Project,
  Track,
  VisualClip,
} from '../model/types.ts'
import { DEFAULT_CATALOG, findItem, type DirectorCatalog } from './catalog.ts'
import {
  applyBindings,
  effectInstance,
  normalizeColor,
  paramContext,
  transition,
  type ParamContext,
} from './compile.ts'
import { AUDIO_SOURCES, COLOR_KEYS } from './plan.ts'
import type { IdMap } from './project-summary.ts'
import { lyricTextCommands } from './retime.ts'

export const PROPERTIES = [
  'opacity',
  'x',
  'y',
  'scale',
  'rotation',
  'volume',
  'speed',
  'muted',
  'enabled',
  'blendMode',
  'text',
  'color',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'uppercase',
  ...COLOR_KEYS,
] as const
export type Property = (typeof PROPERTIES)[number]

const ANIMATABLE = ['opacity', 'x', 'y', 'scale', 'rotation', 'volume', ...COLOR_KEYS] as const

const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'add',
  'darken',
  'lighten',
  'soft-light',
  'hard-light',
  'difference',
  'color-dodge',
  'color-burn',
]

const id = z.string().min(1)
const time = z.number().finite().min(0)
const scalar = z.union([z.number(), z.string(), z.boolean()])

const selectorSchema = z
  .object({
    type: z.enum(['video', 'image', 'text', 'solid', 'generator', 'adjustment', 'audio']).optional(),
    track: id.optional().describe('track id'),
    section: id.optional().describe('song section id; picks clips that overlap it'),
    from: time.optional().describe('picks clips that overlap [from, to)'),
    to: time.optional(),
    textContains: z.string().optional(),
    madeByDirector: z.boolean().optional(),
  })
  .describe('picks clips by type, track, section or time range instead of listing ids')

const targetSchema = z
  .union([z.array(id).min(1).describe('clip ids'), selectorSchema])
  .meta({ id: 'Clips', description: 'clip ids, or a selector' })

const keyframeSchema = z.object({
  time: time.describe("seconds from each clip's start"),
  value: z.number(),
  easing: z.enum(['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
})

export const operationSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('set'), clips: targetSchema, property: z.enum(PROPERTIES), value: scalar })
    .describe('Set a property. Replaces any animation of it.'),
  z
    .object({
      op: z.literal('animate'),
      clips: targetSchema,
      property: z.enum(ANIMATABLE),
      keyframes: z.array(keyframeSchema).min(1).max(24),
    })
    .describe('Add keyframes to a property'),
  z
    .object({
      op: z.literal('fade'),
      clips: targetSchema,
      direction: z.enum(['in', 'out', 'both']),
      duration: z.number().min(0.05).max(10).optional().describe('seconds, default 1'),
    })
    .describe('Fade clips in at their start and/or out at their end (opacity, or volume for audio)'),
  z
    .object({
      op: z.literal('react'),
      clips: targetSchema,
      property: z.enum(['opacity', 'x', 'y', 'scale', 'rotation', ...COLOR_KEYS]),
      source: z.enum(AUDIO_SOURCES),
      amount: z.number().min(-2).max(2).describe('0.05 subtle, 0.15 clear, 0.4 strong'),
    })
    .describe('Make a property move with the music'),
  z
    .object({
      op: z.literal('clear'),
      clips: targetSchema,
      property: z.enum(ANIMATABLE),
      what: z.enum(['animation', 'music', 'both']),
    })
    .describe('Remove keyframes and/or music reaction from a property'),
  z
    .object({
      op: z.literal('move'),
      clips: targetSchema,
      to: time.optional().describe('new start of the earliest clip; the others keep their spacing'),
      by: z.number().optional().describe('seconds to shift by'),
      track: id.optional(),
    })
    .describe('Move clips in time or to another track'),
  z
    .object({ op: z.literal('trim'), clips: targetSchema, start: time.optional(), end: time.optional() })
    .describe('Change where clips start or end on the timeline'),
  z.object({ op: z.literal('split'), clips: targetSchema, time }).describe('Split clips at a timeline time'),
  z.object({ op: z.literal('remove'), clips: targetSchema }).describe('Delete clips'),
  z
    .object({
      op: z.literal('duplicate'),
      clips: targetSchema,
      to: time.optional(),
      by: z.number().optional(),
    })
    .describe('Copy clips; without to/by the copy goes right after the original'),
  z
    .object({
      op: z.literal('add_text'),
      text: z.string().min(1).max(500),
      start: time,
      end: time,
      x: z.number().optional(),
      y: z.number().optional(),
      fontSize: z.number().optional(),
      color: z.string().optional(),
      animation: z.string().optional().describe('text animation id from the catalog'),
      track: id.optional(),
    })
    .describe('Add a text clip'),
  z
    .object({
      op: z.literal('add_visualizer'),
      visualizer: z.string(),
      start: time,
      end: time,
      color: z.string().optional(),
      track: id.optional(),
    })
    .describe('Add a music visualizer'),
  z
    .object({
      op: z.literal('add_effect'),
      clips: targetSchema,
      effect: z.string(),
      params: z.record(z.string(), scalar).optional(),
      react: z
        .object({ param: z.string(), source: z.enum(AUDIO_SOURCES), amount: z.number().min(-2).max(2) })
        .optional()
        .describe('drive one numeric param with the music; amount is a share of its range'),
    })
    .describe('Add an effect from the catalog'),
  z
    .object({
      op: z.literal('set_effect'),
      clips: targetSchema,
      effect: z.string(),
      params: z.record(z.string(), scalar),
    })
    .describe('Change params of an effect the clips already have'),
  z.object({ op: z.literal('remove_effect'), clips: targetSchema, effect: z.string() }),
  z
    .object({
      op: z.literal('transition'),
      clips: targetSchema,
      side: z.enum(['in', 'out', 'both']),
      kind: z.string().describe('transition id from the catalog, or "none"'),
      duration: z.number().min(0.02).max(4).optional(),
    })
    .describe('Set or remove transitions'),
  z.object({ op: z.literal('add_marker'), time, label: z.string().max(80) }),
  z.object({ op: z.literal('remove_marker'), marker: id }),
  z.object({
    op: z.literal('track'),
    track: id,
    name: z.string().max(60).optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  z.object({ op: z.literal('rename_project'), name: z.string().min(1).max(120) }),
  z.object({ op: z.literal('set_aspect'), aspect: z.enum(['16:9', '9:16', '1:1', '4:5']) }),
  z.object({ op: z.literal('edit_lyric'), line: id, text: z.string().min(1).max(300) }),
])

export type Operation = z.infer<typeof operationSchema>
type Target = z.infer<typeof targetSchema>

export class OperationError extends Error {
  readonly index: number
  constructor(index: number, op: string, message: string) {
    super(`Operation ${index + 1} (${op}): ${message}`)
    this.name = 'OperationError'
    this.index = index
  }
}

export interface CompiledOperations {
  commands: EditCommand[]
  /** The project after the commands (from the scratch editor). */
  project: Project
  warnings: string[]
  /** Short ids given to clips added by the operations (n1, n2, ...). */
  added: Map<string, Id>
}

interface OpCtx {
  scratch: ProjectEditor
  ids: IdMap
  added: Map<string, Id>
  catalog: DirectorCatalog
  params: ParamContext
  warnings: string[]
  index: number
  op: Operation
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

function fail(ctx: OpCtx, message: string): never {
  throw new OperationError(ctx.index, ctx.op.op, message)
}

function project(ctx: OpCtx): Project {
  return ctx.scratch.getProject()
}

function realId(ctx: OpCtx, short: string): Id | undefined {
  return ctx.added.get(short) ?? ctx.ids.toReal.get(short)
}

function trackOf(ctx: OpCtx, short: string): Track {
  const realTrack = realId(ctx, short)
  const track = project(ctx).tracks.find((t) => t.id === realTrack)
  if (!track) fail(ctx, `track ${short} doesn't exist`)
  return track
}

function resolveClips(ctx: OpCtx, target: Target): Clip[] {
  const p = project(ctx)
  if (Array.isArray(target)) {
    return target.map((short) => {
      const clip = p.clips[realId(ctx, short) ?? '']
      if (!clip) fail(ctx, `clip ${short} doesn't exist`)
      return clip
    })
  }
  let from = target.from ?? 0
  let to = target.to ?? Infinity
  if (target.section) {
    const sectionId = realId(ctx, target.section)
    const sections = (p.songAssetId ? p.analysis.audio[p.songAssetId]?.sections : undefined) ?? []
    // Small models often pass a lyric line id as the section; its time span is what they mean.
    const line = p.lyrics?.lines.find((l) => l.id === sectionId)
    const span =
      sections.find((s) => s.id === sectionId) ??
      (line?.start !== undefined && line.end !== undefined && line.end > line.start
        ? { start: line.start, end: line.end }
        : undefined)
    if (!span) {
      const known = sections.map((s) => ctx.ids.toShort.get(s.id)).filter(Boolean)
      fail(
        ctx,
        known.length
          ? `section ${target.section} doesn't exist; the song sections are ${known.join(', ')}`
          : `section ${target.section} doesn't exist; the song has no sections, so use from and to instead`,
      )
    }
    from = Math.max(from, span.start)
    to = Math.min(to, span.end)
  }
  const trackId = target.track ? trackOf(ctx, target.track).id : undefined
  const needle = target.textContains?.toLowerCase()
  const clips = Object.values(p.clips)
    .filter(
      (c) =>
        (!target.type || c.type === target.type) &&
        (!trackId || c.trackId === trackId) &&
        c.start < to &&
        c.start + c.duration > from &&
        (!needle || (c.type === 'text' && c.text.toLowerCase().includes(needle))) &&
        (target.madeByDirector === undefined ||
          (typeof c.meta?.director === 'object') === target.madeByDirector),
    )
    .sort((a, b) => a.start - b.start)
  if (clips.length === 0) fail(ctx, 'no clips match that selection')
  return clips
}

function apply(ctx: OpCtx, commands: EditCommand[]): EditCommand[] {
  if (commands.length === 0) return commands
  try {
    // The editor freezes objects it stores; clone so the returned commands can be dispatched again for real.
    ctx.scratch.dispatch(structuredClone(commands))
  } catch (error) {
    if (error instanceof EditError) {
      fail(ctx, error.code === 'locked' ? 'that track is locked; ask the user to unlock it' : error.message)
    }
    throw error
  }
  return commands
}

function visual(clip: Clip): clip is VisualClip {
  return clip.type !== 'audio'
}

interface PropertyTarget {
  paths: (string | number)[][]
  kind: 'animatable' | 'plain'
  /** Present when the Animatable may be missing (color adjustments). */
  adjustment?: (typeof COLOR_KEYS)[number]
}

function propertyTarget(clip: Clip, property: Property): PropertyTarget | undefined {
  const isColorKey = (COLOR_KEYS as readonly string[]).includes(property)
  if (isColorKey) {
    return visual(clip)
      ? {
          paths: [['adjustments', property]],
          kind: 'animatable',
          adjustment: property as (typeof COLOR_KEYS)[number],
        }
      : undefined
  }
  switch (property) {
    case 'opacity':
      return visual(clip) ? { paths: [['opacity']], kind: 'animatable' } : undefined
    case 'x':
    case 'y':
    case 'rotation':
      return visual(clip) ? { paths: [['transform', property]], kind: 'animatable' } : undefined
    case 'scale':
      return visual(clip)
        ? {
            paths: [
              ['transform', 'scaleX'],
              ['transform', 'scaleY'],
            ],
            kind: 'animatable',
          }
        : undefined
    case 'volume':
      return clip.type === 'video' || clip.type === 'audio'
        ? { paths: [['volume']], kind: 'animatable' }
        : undefined
    case 'speed':
      return clip.type === 'video' || clip.type === 'audio'
        ? { paths: [['playbackRate']], kind: 'plain' }
        : undefined
    case 'muted':
      return clip.type === 'video' || clip.type === 'audio'
        ? { paths: [['muted']], kind: 'plain' }
        : undefined
    case 'enabled':
      return { paths: [['enabled']], kind: 'plain' }
    case 'blendMode':
      return visual(clip) && clip.type !== 'adjustment'
        ? { paths: [['blendMode']], kind: 'plain' }
        : undefined
    case 'text':
      return clip.type === 'text' ? { paths: [['text']], kind: 'plain' } : undefined
    case 'color':
      if (clip.type === 'text') return { paths: [['style', 'color']], kind: 'plain' }
      if (clip.type === 'solid') return { paths: [['color']], kind: 'animatable' }
      if (clip.type === 'generator' && clip.params.color)
        return { paths: [['params', 'color']], kind: 'animatable' }
      return undefined
    case 'fontSize':
    case 'fontFamily':
    case 'fontWeight':
      return clip.type === 'text' ? { paths: [['style', property]], kind: 'plain' } : undefined
    case 'uppercase':
      return clip.type === 'text' ? { paths: [['style', 'textTransform']], kind: 'plain' } : undefined
  }
  return undefined
}

function coerceValue(ctx: OpCtx, property: Property, value: ParamValue | boolean): ParamValue {
  const number = (min: number, max: number) => {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) fail(ctx, `${property} needs a number`)
    return r3(Math.max(min, Math.min(max, n)))
  }
  const bool = () => {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 'false') return value === 'true'
    fail(ctx, `${property} needs true or false`)
  }
  if ((COLOR_KEYS as readonly string[]).includes(property)) return number(-1, 1)
  switch (property) {
    case 'opacity':
      return number(0, 1)
    case 'x':
    case 'y':
      return number(-1, 2)
    case 'scale':
      return number(0.05, 10)
    case 'rotation':
      return number(-720, 720)
    case 'volume':
      return number(0, 2)
    case 'speed':
      return number(0.25, 4)
    case 'fontSize':
      return number(8, 400)
    case 'fontWeight':
      return Math.round(number(100, 900) / 100) * 100
    case 'muted':
    case 'enabled':
      return bool()
    case 'uppercase':
      return bool() ? 'uppercase' : 'none'
    case 'blendMode':
      if (typeof value === 'string' && (BLEND_MODES as string[]).includes(value)) return value
      return fail(ctx, `blendMode must be one of ${BLEND_MODES.join(', ')}`)
    case 'color': {
      const color = typeof value === 'string' ? normalizeColor(value, '') : ''
      if (!color) fail(ctx, 'color must be a hex color like #ff3366')
      return color
    }
    case 'text':
    case 'fontFamily':
      if (typeof value !== 'string' || !value.trim()) fail(ctx, `${property} needs text`)
      return value
  }
  return value as ParamValue
}

function getAt(node: unknown, path: (string | number)[]): unknown {
  let cur = node
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

/** Commands that make sure clip.adjustments[key] exists before it is changed by path. */
function ensureAdjustment(clip: VisualClip, key: (typeof COLOR_KEYS)[number]): EditCommand[] {
  if (clip.adjustments?.[key]) return []
  return [
    {
      type: 'clip.set',
      clipId: clip.id,
      path: ['adjustments'],
      value: { ...clip.adjustments, [key]: { value: 0 } },
    },
  ]
}

function applicable(ctx: OpCtx, clips: Clip[], property: Property) {
  const pairs = clips
    .map((clip) => ({ clip, target: propertyTarget(clip, property) }))
    .filter((p): p is { clip: Clip; target: PropertyTarget } => !!p.target)
  if (pairs.length === 0)
    fail(ctx, `${property} doesn't apply to ${clips.length === 1 ? 'that clip' : 'those clips'}`)
  if (pairs.length < clips.length) {
    ctx.warnings.push(`${property} was skipped for ${clips.length - pairs.length} clips it doesn't apply to.`)
  }
  return pairs
}

function setOp(ctx: OpCtx, op: Extract<Operation, { op: 'set' }>) {
  const value = coerceValue(ctx, op.property, op.value)
  const commands: EditCommand[] = []
  for (const { clip, target } of applicable(ctx, resolveClips(ctx, op.clips), op.property)) {
    if (target.adjustment) commands.push(...ensureAdjustment(clip as VisualClip, target.adjustment))
    for (const path of target.paths) {
      if (target.kind === 'animatable') {
        const current = getAt(clip, path) as Animatable<ParamValue> | undefined
        const next: Animatable<ParamValue> = {
          value,
          ...(current?.modulation ? { modulation: current.modulation } : {}),
        }
        commands.push({ type: 'clip.set', clipId: clip.id, path, value: next })
      } else {
        commands.push({ type: 'clip.set', clipId: clip.id, path, value })
      }
    }
  }
  return apply(ctx, commands)
}

function animateOp(ctx: OpCtx, op: Extract<Operation, { op: 'animate' }>) {
  const commands: EditCommand[] = []
  for (const { clip, target } of applicable(ctx, resolveClips(ctx, op.clips), op.property)) {
    if (target.adjustment) commands.push(...ensureAdjustment(clip as VisualClip, target.adjustment))
    for (const path of target.paths) {
      for (const k of op.keyframes) {
        const value = coerceValue(ctx, op.property, k.value) as number
        commands.push({
          type: 'keyframe.set',
          clipId: clip.id,
          path,
          keyframe: { time: r3(Math.min(clip.duration, k.time)), value, easing: k.easing ?? 'ease-in-out' },
        })
      }
    }
  }
  return apply(ctx, commands)
}

function fadeOp(ctx: OpCtx, op: Extract<Operation, { op: 'fade' }>) {
  const commands: EditCommand[] = []
  for (const clip of resolveClips(ctx, op.clips)) {
    const path = [clip.type === 'audio' ? 'volume' : 'opacity']
    const current = getAt(clip, path) as Animatable<number> | undefined
    const full = typeof current?.value === 'number' ? current.value : 1
    const room = op.direction === 'both' ? clip.duration / 2 : clip.duration
    const length = r3(Math.min(op.duration ?? 1, room))
    const keys: [number, number][] = []
    if (op.direction !== 'out') keys.push([0, 0], [length, full])
    if (op.direction !== 'in') keys.push([r3(clip.duration - length), full], [r3(clip.duration), 0])
    for (const [time, value] of keys) {
      commands.push({
        type: 'keyframe.set',
        clipId: clip.id,
        path,
        keyframe: { time, value, easing: 'linear' },
      })
    }
  }
  return apply(ctx, commands)
}

function reactOp(ctx: OpCtx, op: Extract<Operation, { op: 'react' }>) {
  const commands: EditCommand[] = []
  for (const { clip, target } of applicable(ctx, resolveClips(ctx, op.clips), op.property)) {
    const copy = structuredClone(clip) as VisualClip
    applyBindings(copy, [{ target: op.property, source: op.source, amount: op.amount }], ctx.params)
    const paths = target.adjustment ? [['adjustments']] : target.paths
    for (const path of paths)
      commands.push({ type: 'clip.set', clipId: clip.id, path, value: getAt(copy, path) })
  }
  return apply(ctx, commands)
}

function clearOp(ctx: OpCtx, op: Extract<Operation, { op: 'clear' }>) {
  const commands: EditCommand[] = []
  for (const { clip, target } of applicable(ctx, resolveClips(ctx, op.clips), op.property)) {
    for (const path of target.paths) {
      const current = getAt(clip, path) as Animatable<ParamValue> | undefined
      if (!current) continue
      const next: Animatable<ParamValue> = { value: current.value }
      if (op.what === 'music' && current.keyframes) next.keyframes = current.keyframes
      if (op.what === 'animation' && current.modulation) next.modulation = current.modulation
      commands.push({ type: 'clip.set', clipId: clip.id, path, value: next })
    }
  }
  return apply(ctx, commands)
}

function moveOp(ctx: OpCtx, op: Extract<Operation, { op: 'move' }>) {
  const clips = resolveClips(ctx, op.clips)
  if (op.to === undefined && op.by === undefined && !op.track) fail(ctx, 'give to, by or track')
  const first = Math.min(...clips.map((c) => c.start))
  const shift = op.to !== undefined ? op.to - first : (op.by ?? 0)
  const trackId = op.track ? trackOf(ctx, op.track).id : undefined
  return apply(ctx, [
    {
      type: 'clip.move',
      moves: clips.map((c) => ({
        clipId: c.id,
        start: r3(Math.max(0, c.start + shift)),
        ...(trackId ? { trackId } : {}),
      })),
    },
  ])
}

function trimOp(ctx: OpCtx, op: Extract<Operation, { op: 'trim' }>) {
  if (op.start === undefined && op.end === undefined) fail(ctx, 'give start or end')
  const commands: EditCommand[] = resolveClips(ctx, op.clips).map((c) => {
    const start = op.start ?? c.start
    const end = op.end ?? c.start + c.duration
    if (end - start < 0.05) fail(ctx, 'the clip would end before it starts')
    return { type: 'clip.trim', clipId: c.id, start: r3(start), duration: r3(end - start) }
  })
  return apply(ctx, commands)
}

function splitOp(ctx: OpCtx, op: Extract<Operation, { op: 'split' }>) {
  const inside = resolveClips(ctx, op.clips).filter(
    (c) => op.time > c.start + 0.01 && op.time < c.start + c.duration - 0.01,
  )
  if (inside.length === 0) fail(ctx, 'no selected clip spans that time')
  return apply(
    ctx,
    inside.map((c) => ({ type: 'clip.split', clipId: c.id, time: op.time, newClipId: newId() })),
  )
}

function freshCopy(clip: Clip): Clip {
  const copy = structuredClone(clip) as Clip & { meta?: unknown }
  copy.id = newId()
  delete copy.meta
  if ('effects' in copy) copy.effects = copy.effects.map((e) => ({ ...e, id: newId() }))
  return copy
}

function remember(ctx: OpCtx, clipId: Id) {
  ctx.added.set(`n${ctx.added.size + 1}`, clipId)
}

function duplicateOp(ctx: OpCtx, op: Extract<Operation, { op: 'duplicate' }>) {
  const clips = resolveClips(ctx, op.clips)
  const first = Math.min(...clips.map((c) => c.start))
  const last = Math.max(...clips.map((c) => c.start + c.duration))
  const shift = op.to !== undefined ? op.to - first : op.by !== undefined ? op.by : last - first
  const commands: EditCommand[] = clips.map((c) => {
    const copy = freshCopy(c)
    copy.start = r3(Math.max(0, c.start + shift))
    remember(ctx, copy.id)
    return { type: 'clip.add', clip: copy }
  })
  return apply(ctx, commands)
}

/** A visual track with room for [start, end): the given one, a free text track, or a new track on top. */
function trackFor(
  ctx: OpCtx,
  start: number,
  end: number,
  short: string | undefined,
  name: string,
): { trackId: Id; commands: EditCommand[] } {
  if (short) {
    const track = trackOf(ctx, short)
    if (track.kind !== 'visual') fail(ctx, `track ${short} is an audio track`)
    return { trackId: track.id, commands: [] }
  }
  const p = project(ctx)
  const free = p.tracks.find(
    (t) =>
      t.kind === 'visual' &&
      !t.locked &&
      t.name === name &&
      !Object.values(p.clips).some(
        (c) => c.trackId === t.id && c.start < end && c.start + c.duration > start,
      ),
  )
  if (free) return { trackId: free.id, commands: [] }
  const track = createTrack('visual', name)
  return { trackId: track.id, commands: [{ type: 'track.add', track, index: 0 }] }
}

function addTextOp(ctx: OpCtx, op: Extract<Operation, { op: 'add_text' }>) {
  if (op.end - op.start < 0.1) fail(ctx, 'end must be after start')
  const { trackId, commands } = trackFor(ctx, op.start, op.end, op.track, 'Text')
  const clip = createTextClip({
    trackId,
    text: op.text,
    start: r3(op.start),
    duration: r3(op.end - op.start),
    style: {
      ...(op.fontSize ? { fontSize: Math.max(8, Math.min(400, op.fontSize)) } : {}),
      ...(op.color ? { color: normalizeColor(op.color, '#ffffff') } : {}),
    },
  })
  if (op.x !== undefined) clip.transform.x = { value: r3(op.x) }
  if (op.y !== undefined) clip.transform.y = { value: r3(op.y) }
  if (op.animation) {
    if (!findItem(ctx.catalog.textPresets, op.animation))
      fail(ctx, `text animation ${op.animation} isn't in the catalog`)
    clip.animation = { presetId: op.animation, params: {} }
  }
  remember(ctx, clip.id)
  return apply(ctx, [...commands, { type: 'clip.add', clip }])
}

function addVisualizerOp(ctx: OpCtx, op: Extract<Operation, { op: 'add_visualizer' }>) {
  const item = findItem(ctx.catalog.generators, op.visualizer)
  if (!item) fail(ctx, `visualizer ${op.visualizer} isn't in the catalog`)
  if (op.end - op.start < 0.1) fail(ctx, 'end must be after start')
  const { trackId, commands } = trackFor(ctx, op.start, op.end, op.track, 'Visualizer')
  const params: Record<string, Animatable<ParamValue>> = {}
  for (const p of item.params ?? []) params[p.key] = { value: p.default }
  if (op.color && params.color) params.color = { value: normalizeColor(op.color, String(params.color.value)) }
  const clip: GeneratorClip = {
    id: newId(),
    trackId,
    start: r3(op.start),
    duration: r3(op.end - op.start),
    enabled: true,
    transform: defaultTransform(),
    opacity: { value: 1 },
    blendMode: 'normal',
    effects: [],
    type: 'generator',
    generatorId: item.id,
    params,
  }
  remember(ctx, clip.id)
  return apply(ctx, [...commands, { type: 'clip.add', clip }])
}

function effectClips(ctx: OpCtx, target: Target): VisualClip[] {
  const clips = resolveClips(ctx, target).filter(visual)
  if (clips.length === 0) fail(ctx, 'effects only apply to visual clips')
  return clips
}

function addEffectOp(ctx: OpCtx, op: Extract<Operation, { op: 'add_effect' }>) {
  const item = findItem(ctx.catalog.effects, op.effect)
  if (!item) fail(ctx, `effect ${op.effect} isn't in the catalog`)
  const known = new Set((item.params ?? []).map((p) => p.key))
  for (const key of [...Object.keys(op.params ?? {}), ...(op.react ? [op.react.param] : [])]) {
    if (!known.has(key))
      fail(ctx, `${op.effect} has no param ${key}; it has ${[...known].join(', ') || 'none'}`)
  }
  const commands: EditCommand[] = effectClips(ctx, op.clips).map((clip) => {
    const effect = effectInstance(
      { effectId: item.id, params: op.params, ...(op.react ? { react: [op.react] } : {}) },
      ctx.params,
    )
    if (!effect) fail(ctx, `effect ${op.effect} isn't available`)
    return { type: 'effect.add', clipId: clip.id, effect }
  })
  return apply(ctx, commands)
}

function setEffectOp(ctx: OpCtx, op: Extract<Operation, { op: 'set_effect' }>) {
  const item = findItem(ctx.catalog.effects, op.effect)
  const commands: EditCommand[] = []
  for (const clip of effectClips(ctx, op.clips)) {
    const index = clip.effects.findIndex((e) => e.effectId === op.effect)
    if (index < 0) continue
    for (const [key, value] of Object.entries(op.params)) {
      const spec = item?.params?.find((p) => p.key === key)
      if (item && !spec) fail(ctx, `${op.effect} has no param ${key}`)
      let v: ParamValue = value
      if (typeof v === 'number' && spec?.min !== undefined && spec.max !== undefined)
        v = Math.max(spec.min, Math.min(spec.max, v))
      const current = clip.effects[index]?.params[key]
      commands.push({
        type: 'clip.set',
        clipId: clip.id,
        path: ['effects', index, 'params', key],
        value: { value: v, ...(current?.modulation ? { modulation: current.modulation } : {}) },
      })
    }
  }
  if (commands.length === 0) fail(ctx, `none of those clips has ${op.effect}`)
  return apply(ctx, commands)
}

function removeEffectOp(ctx: OpCtx, op: Extract<Operation, { op: 'remove_effect' }>) {
  const commands: EditCommand[] = effectClips(ctx, op.clips).flatMap((clip) =>
    clip.effects
      .filter((e) => e.effectId === op.effect)
      .map((e): EditCommand => ({ type: 'effect.remove', clipId: clip.id, effectInstanceId: e.id })),
  )
  if (commands.length === 0) fail(ctx, `none of those clips has ${op.effect}`)
  return apply(ctx, commands)
}

function transitionOp(ctx: OpCtx, op: Extract<Operation, { op: 'transition' }>) {
  const none = op.kind === 'none' || op.kind === 'cut'
  if (!none && !findItem(ctx.catalog.transitions, op.kind))
    fail(ctx, `transition ${op.kind} isn't in the catalog`)
  const sides =
    op.side === 'both'
      ? (['transitionIn', 'transitionOut'] as const)
      : op.side === 'in'
        ? (['transitionIn'] as const)
        : (['transitionOut'] as const)
  const commands: EditCommand[] = []
  for (const clip of effectClips(ctx, op.clips)) {
    const value = none
      ? undefined
      : transition({ kind: op.kind, duration: op.duration ?? 0.4 }, clip.duration, ctx.params)
    for (const side of sides) commands.push({ type: 'clip.set', clipId: clip.id, path: [side], value })
  }
  return apply(ctx, commands)
}

function runOperation(ctx: OpCtx): EditCommand[] {
  const op = ctx.op
  switch (op.op) {
    case 'set':
      return setOp(ctx, op)
    case 'animate':
      return animateOp(ctx, op)
    case 'fade':
      return fadeOp(ctx, op)
    case 'react':
      return reactOp(ctx, op)
    case 'clear':
      return clearOp(ctx, op)
    case 'move':
      return moveOp(ctx, op)
    case 'trim':
      return trimOp(ctx, op)
    case 'split':
      return splitOp(ctx, op)
    case 'remove':
      return apply(ctx, [{ type: 'clip.remove', clipIds: resolveClips(ctx, op.clips).map((c) => c.id) }])
    case 'duplicate':
      return duplicateOp(ctx, op)
    case 'add_text':
      return addTextOp(ctx, op)
    case 'add_visualizer':
      return addVisualizerOp(ctx, op)
    case 'add_effect':
      return addEffectOp(ctx, op)
    case 'set_effect':
      return setEffectOp(ctx, op)
    case 'remove_effect':
      return removeEffectOp(ctx, op)
    case 'transition':
      return transitionOp(ctx, op)
    case 'add_marker':
      return apply(ctx, [
        { type: 'marker.add', marker: { id: newId(), time: r3(op.time), kind: 'user', label: op.label } },
      ])
    case 'remove_marker': {
      const markerId = realId(ctx, op.marker)
      if (!markerId || !project(ctx).markers.some((m) => m.id === markerId))
        fail(ctx, `marker ${op.marker} doesn't exist`)
      return apply(ctx, [{ type: 'marker.remove', markerId }])
    }
    case 'track': {
      const track = trackOf(ctx, op.track)
      const patch = Object.fromEntries(
        (['name', 'muted', 'hidden', 'locked'] as const)
          .filter((k) => op[k] !== undefined)
          .map((k) => [k, op[k]]),
      )
      return apply(ctx, [{ type: 'track.update', trackId: track.id, patch }])
    }
    case 'rename_project':
      return apply(ctx, [{ type: 'project.rename', name: op.name }])
    case 'set_aspect': {
      const { width, height } = ASPECT_PRESETS[op.aspect]
      return apply(ctx, [{ type: 'project.updateSettings', settings: { aspect: op.aspect, width, height } }])
    }
    case 'edit_lyric': {
      const lineId = realId(ctx, op.line)
      if (!lineId || !project(ctx).lyrics?.lines.some((l) => l.id === lineId))
        fail(ctx, `lyric line ${op.line} doesn't exist`)
      return apply(ctx, [
        ...lyricTextCommands(project(ctx), lineId, op.text),
        { type: 'lyrics.updateLine', lineId, patch: { text: op.text } },
      ])
    }
  }
}

/** Validates and compiles operations against `project`. Throws OperationError naming the first bad operation. */
export function compileOperations(
  operations: Operation[],
  base: Project,
  ids: IdMap,
  catalog: DirectorCatalog = DEFAULT_CATALOG,
): CompiledOperations {
  const scratch = new ProjectEditor(base)
  const added = new Map<string, Id>()
  const warnings: string[] = []
  const params = paramContext(base, catalog)
  const commands: EditCommand[] = []
  for (const [index, op] of operations.entries()) {
    commands.push(...runOperation({ scratch, ids, added, catalog, params, warnings, index, op }))
  }
  return {
    commands,
    project: scratch.getProject(),
    warnings: [...new Set([...warnings, ...params.warnings])],
    added,
  }
}
