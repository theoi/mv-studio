/**
 * Compiles an EditPlan into ordinary EditCommands: director tracks, clips with keyframed camera moves, effects,
 * transitions, audio-reactive modulation, lyric text and a look adjustment layer. Dispatch the result as one undo
 * step. Every clip carries meta.director so a later run can replace the previous draft without touching the user's
 * own clips. Ids the catalog does not know are left out with a warning instead of failing.
 */
import type { EditCommand, PropertyPath } from '../model/commands.ts'
import { createTrack, DEFAULT_TEXT_STYLE, defaultTransform, newId } from '../model/factory.ts'
import { clipsOnTrack } from '../model/queries.ts'
import type {
  Animatable,
  Asset,
  AudioClip,
  AudioFeatureSource,
  AudioModulation,
  Clip,
  ColorAdjustments,
  EffectInstance,
  Id,
  JsonObject,
  Keyframe,
  ParamValue,
  Project,
  Seconds,
  TextClip,
  TextStyle,
  Track,
  Transition,
  VisualClip,
} from '../model/types.ts'
import { reactionCommands, type ReactionTarget } from '../plugins/reactions.ts'
import { behindSubjectMatte } from '../vision/index.ts'
import { DEFAULT_CATALOG, findItem, type DirectorCatalog } from './catalog.ts'
import { DIRECTOR_META_KEY, directorMeta, type DirectorClipMeta, type DirectorTrackRole } from './meta.ts'
import type {
  AudioBinding,
  EditPlan,
  EffectSpec,
  GenerateSource,
  Motion,
  PlanLook,
  PlanShot,
  PlanText,
  ReactionSpec,
  ShotLayer,
  TransitionSpec,
} from './plan.ts'

/** Top to bottom. Text stays above the look layer so lyrics are not color graded. */
const TRACK_ORDER: DirectorTrackRole[] = ['text', 'look', 'accent', 'overlay', 'shots']

const TRACK_NAMES: Record<DirectorTrackRole, string> = {
  text: 'Director · Text',
  look: 'Director · Look',
  accent: 'Director · Accents',
  overlay: 'Director · Overlay',
  shots: 'Director · Shots',
}

const LAYER_ROLE: Record<ShotLayer, DirectorTrackRole> = {
  main: 'shots',
  overlay: 'overlay',
  accent: 'accent',
}

const PLACEHOLDER_COLOR = '#1c1c28'

function metaObject(meta: DirectorClipMeta): JsonObject {
  return { [DIRECTOR_META_KEY]: JSON.parse(JSON.stringify(meta)) as JsonObject }
}

export interface CompileOptions {
  catalog?: DirectorCatalog
  /** Generated media by shot id. Shots with `sameAs` use the asset of the shot they point to. */
  generated?: ReadonlyMap<string, Asset>
  /** Remove clips from earlier director drafts (default true). */
  replacePrevious?: boolean
}

export interface CompileStats {
  shots: number
  texts: number
  /** AI shots without media yet, shown as dark placeholder clips. */
  placeholders: number
  removedClips: number
  addedTracks: number
}

export interface CompiledPlan {
  commands: EditCommand[]
  /** Undo menu label. */
  label: string
  warnings: string[]
  stats: CompileStats
}

const round3 = (t: number) => Math.round(t * 1000) / 1000

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** '#rgb', '#rrggbb' or '#rrggbbaa' as '#rrggbb[aa]'; anything else becomes `fallback`. */
export function normalizeColor(value: string | undefined, fallback: string): string {
  const v = value?.trim()
  if (!v || !HEX.test(v)) return fallback
  if (v.length === 4) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase()
  return v.toLowerCase()
}

/** What building effects, transitions and modulation needs; shared with plain-language edits. */
export interface ParamContext {
  catalog: DirectorCatalog
  warnings: string[]
  source: (name: AudioBinding['source'], stem?: AudioBinding['stem']) => AudioFeatureSource
}

interface Ctx extends ParamContext {
  project: Project
  plan: EditPlan
}

export function paramContext(project: Project, catalog: DirectorCatalog = DEFAULT_CATALOG): ParamContext {
  return { catalog, warnings: [], source: audioSourceMapper(project, project.songAssetId) }
}

function warn(ctx: Pick<ParamContext, 'warnings'>, message: string) {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message)
}

/** Picks the analysis band whose center is closest to `hz` on a log scale. */
function bandNear(hz: number, edges: number[], count: number): number {
  if (count <= 0) return 0
  const centers =
    edges.length === count + 1
      ? Array.from({ length: count }, (_, i) =>
          Math.sqrt(Math.max(1, edges[i] as number) * (edges[i + 1] as number)),
        )
      : edges.length === count
        ? edges.map((e) => Math.max(1, e))
        : Array.from({ length: count }, (_, i) => 40 * Math.pow(16000 / 40, (i + 0.5) / count))
  let best = 0
  for (let i = 1; i < centers.length; i++) {
    if (Math.abs(Math.log((centers[i] as number) / hz)) < Math.abs(Math.log((centers[best] as number) / hz)))
      best = i
  }
  return best
}

/** Maps plan audio sources (loudness, bass, beat...) to analysis features of the song. */
export function audioSourceMapper(project: Project, songAssetId: Id | undefined) {
  const analysis = songAssetId ? project.analysis.audio[songAssetId] : undefined
  const features = analysis?.features
  const count = features?.bands[0]?.length ?? 0
  const edges = features?.bandEdgesHz ?? []
  const band = (hz: number, stem?: AudioBinding['stem']): AudioFeatureSource => ({
    kind: 'band',
    band: bandNear(hz, edges, count),
    ...(stem ? { stem } : {}),
  })
  return (name: AudioBinding['source'], stem?: AudioBinding['stem']): AudioFeatureSource => {
    switch (name) {
      case 'loudness':
        return { kind: 'loudness', ...(stem ? { stem } : {}) }
      case 'onset':
        return { kind: 'onset', ...(stem ? { stem } : {}) }
      case 'beat':
        return { kind: 'beat' }
      case 'downbeat':
        return { kind: 'downbeat' }
      case 'bass':
        if (count > 0) return band(80, stem)
        if (!stem && analysis?.stems?.bass) return { kind: 'loudness', stem: 'bass' }
        return { kind: 'band', band: 0, ...(stem ? { stem } : {}) }
      case 'mid':
        return count > 0 ? band(1000, stem) : { kind: 'loudness', ...(stem ? { stem } : {}) }
      case 'treble':
        return count > 0 ? band(8000, stem) : { kind: 'onset', ...(stem ? { stem } : {}) }
    }
  }
}

export function modulation(
  ctx: ParamContext,
  b: { source: AudioBinding['source']; stem?: AudioBinding['stem'] },
  amount: number,
  mode: 'add' | 'multiply',
  smoothing?: number,
): AudioModulation {
  return { source: ctx.source(b.source, b.stem), amount: round3(amount), mode, smoothing: smoothing ?? 0.3 }
}

function withModulation<T>(anim: Animatable<T>, mod: AudioModulation): Animatable<T> {
  return { ...anim, modulation: [...(anim.modulation ?? []), mod] }
}

export function applyBindings(clip: VisualClip, bindings: AudioBinding[] | undefined, ctx: ParamContext) {
  for (const b of bindings ?? []) {
    switch (b.target) {
      case 'scale': {
        const mod = modulation(ctx, b, b.amount, b.mode ?? 'multiply', b.smoothing)
        clip.transform.scaleX = withModulation(clip.transform.scaleX, mod)
        clip.transform.scaleY = withModulation(clip.transform.scaleY, mod)
        break
      }
      case 'opacity':
        clip.opacity = withModulation(
          clip.opacity,
          modulation(ctx, b, b.amount, b.mode ?? 'multiply', b.smoothing),
        )
        break
      case 'rotation':
        // Plan amounts are unit-free; ten degrees per unit keeps "amount 0.3" a gentle sway.
        clip.transform.rotation = withModulation(
          clip.transform.rotation,
          modulation(ctx, b, b.amount * 10, 'add', b.smoothing),
        )
        break
      case 'x':
      case 'y':
        clip.transform[b.target] = withModulation(
          clip.transform[b.target],
          modulation(ctx, b, b.amount * 0.1, 'add', b.smoothing),
        )
        break
      default: {
        const adjustments: ColorAdjustments = clip.adjustments ?? {}
        adjustments[b.target] = withModulation(
          adjustments[b.target] ?? { value: 0 },
          modulation(ctx, b, b.amount, 'add', b.smoothing),
        )
        clip.adjustments = adjustments
      }
    }
  }
}

const MOTION: Record<
  Exclude<Motion, 'none'>,
  { scale: [number, number]; x?: [number, number]; y?: [number, number] }
> = {
  'push-in': { scale: [1, 1.12] },
  'pull-out': { scale: [1.12, 1] },
  // Camera moves: panning left slides the picture right, drifting up slides it down.
  'pan-left': { scale: [1.12, 1.12], x: [0.465, 0.535] },
  'pan-right': { scale: [1.12, 1.12], x: [0.535, 0.465] },
  'drift-up': { scale: [1.1, 1.1], y: [0.475, 0.525] },
  'drift-down': { scale: [1.1, 1.1], y: [0.525, 0.475] },
}

function ramp(from: number, to: number, duration: Seconds): Animatable {
  if (Math.abs(from - to) < 1e-9) return { value: from }
  const keyframes: Keyframe[] = [
    { time: 0, value: from, easing: 'linear' },
    { time: round3(duration), value: to, easing: 'linear' },
  ]
  return { value: from, keyframes }
}

function applyMotion(clip: VisualClip, motion: Motion | undefined) {
  if (!motion || motion === 'none') return
  const m = MOTION[motion]
  clip.transform.scaleX = ramp(m.scale[0], m.scale[1], clip.duration)
  clip.transform.scaleY = ramp(m.scale[0], m.scale[1], clip.duration)
  if (m.x) clip.transform.x = ramp(m.x[0], m.x[1], clip.duration)
  if (m.y) clip.transform.y = ramp(m.y[0], m.y[1], clip.duration)
}

export function transition(
  spec: TransitionSpec | undefined,
  clipDuration: Seconds,
  ctx: ParamContext,
): Transition | undefined {
  if (!spec) return undefined
  if (!findItem(ctx.catalog.transitions, spec.kind)) {
    warn(ctx, `Transition "${spec.kind}" isn't available, so hard cuts are used instead.`)
    return undefined
  }
  const duration = round3(Math.min(spec.duration, clipDuration / 2))
  if (duration < 0.02) return undefined
  return { kind: spec.kind, duration, easing: 'ease-in-out' }
}

function clampParam(value: ParamValue, min?: number, max?: number): ParamValue {
  if (typeof value !== 'number') return value
  let v = value
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

export function effectInstance(spec: EffectSpec, ctx: ParamContext): EffectInstance | undefined {
  const item = findItem(ctx.catalog.effects, spec.effectId)
  if (!item) {
    warn(ctx, `Effect "${spec.effectId}" isn't available and was left out.`)
    return undefined
  }
  const known = item.params ?? []
  const params: Record<string, Animatable<ParamValue>> = {}
  for (const p of known) params[p.key] = { value: p.default }
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    const p = known.find((k) => k.key === key)
    if (known.length > 0 && !p) continue
    params[key] = { value: clampParam(value, p?.min, p?.max) }
  }
  for (const r of spec.react ?? []) {
    const p = known.find((k) => k.key === r.param)
    const current = params[r.param]
    if (!current || typeof current.value !== 'number' || (known.length > 0 && !p)) continue
    const range = p?.min !== undefined && p?.max !== undefined ? p.max - p.min : 1
    params[r.param] = withModulation(current, modulation(ctx, r, r.amount * range, 'add', r.smoothing))
  }
  return { id: newId(), effectId: item.id, enabled: true, params }
}

function effectsFor(specs: EffectSpec[] | undefined, ctx: Ctx): EffectInstance[] {
  return (specs ?? []).map((s) => effectInstance(s, ctx)).filter((e): e is EffectInstance => !!e)
}

function adjustmentsFrom(values: Partial<Record<string, number>> | undefined): ColorAdjustments | undefined {
  const entries = Object.entries(values ?? {}).filter(([, v]) => typeof v === 'number' && v !== 0)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([k, v]) => [k, { value: Math.max(-1, Math.min(1, v as number)) }]))
}

function visualBase(trackId: Id, start: Seconds, duration: Seconds, meta: DirectorClipMeta, name?: string) {
  return {
    id: newId(),
    trackId,
    ...(name ? { name } : {}),
    start: round3(start),
    duration: round3(duration),
    enabled: true,
    transform: defaultTransform(),
    opacity: { value: 1 },
    blendMode: 'normal' as const,
    effects: [] as EffectInstance[],
    meta: metaObject(meta),
  }
}

function generatedAssetFor(shot: PlanShot, source: GenerateSource, generated: ReadonlyMap<string, Asset>) {
  return generated.get(shot.id) ?? (source.sameAs ? generated.get(source.sameAs) : undefined)
}

function shotClip(
  shot: PlanShot,
  trackId: Id,
  ctx: Ctx,
  generated: ReadonlyMap<string, Asset>,
  stats: CompileStats,
): VisualClip | undefined {
  const end = Math.min(shot.end, ctx.plan.duration)
  const duration = end - shot.start
  if (duration <= 0.01) return undefined
  const meta: DirectorClipMeta = {
    planId: ctx.plan.id,
    role: LAYER_ROLE[shot.layer],
    shotId: shot.id,
    ...(shot.sectionId ? { sectionId: shot.sectionId } : {}),
  }
  const base = () => visualBase(trackId, shot.start, duration, meta, shot.label)
  const s = shot.source
  let clip: VisualClip
  let mediaAsset: Asset | undefined
  let sourceStart = 0
  let playbackRate = 1

  if (s.type === 'media') {
    mediaAsset = ctx.project.assets[s.assetId]
    if (!mediaAsset || (mediaAsset.kind !== 'video' && mediaAsset.kind !== 'image')) {
      warn(ctx, 'Some planned clips use media that is no longer in the project and were left out.')
      return undefined
    }
    sourceStart = s.sourceStart ?? 0
    playbackRate = s.playbackRate ?? 1
  } else if (s.type === 'generate') {
    mediaAsset = generatedAssetFor(shot, s, generated)
    if (!mediaAsset) {
      stats.placeholders++
      clip = {
        ...visualBase(
          trackId,
          shot.start,
          duration,
          {
            ...meta,
            pending: {
              task: s.task,
              prompt: s.prompt,
              modelId: s.modelId,
              ...(s.duration ? { duration: s.duration } : {}),
            },
          },
          shot.label ?? 'AI shot (not generated yet)',
        ),
        type: 'solid',
        color: { value: PLACEHOLDER_COLOR },
      }
      return clip
    }
    if (mediaAsset.kind === 'video' && mediaAsset.duration && mediaAsset.duration < duration * 0.98) {
      playbackRate = Math.max(0.5, Math.floor((mediaAsset.duration / duration) * 100) / 100)
    }
  }

  if (mediaAsset?.kind === 'video') {
    clip = {
      ...base(),
      type: 'video',
      assetId: mediaAsset.id,
      sourceStart: round3(sourceStart),
      playbackRate,
      fit: shot.fit ?? 'cover',
      volume: { value: 1 },
      // The song is the soundtrack; the user can unmute a clip to hear its own sound.
      muted: true,
    }
  } else if (mediaAsset?.kind === 'image') {
    clip = { ...base(), type: 'image', assetId: mediaAsset.id, fit: shot.fit ?? 'cover' }
  } else if (s.type === 'generator') {
    const item = findItem(ctx.catalog.generators, s.generatorId)
    if (!item) {
      warn(ctx, `Visualizer "${s.generatorId}" isn't available, so a plain background is used.`)
      clip = { ...base(), type: 'solid', color: { value: '#101018' } }
    } else {
      const params: Record<string, Animatable<ParamValue>> = {}
      for (const p of item.params ?? []) params[p.key] = { value: p.default }
      for (const [key, value] of Object.entries(s.params ?? {})) {
        const p = item.params?.find((k) => k.key === key)
        if (item.params?.length && !p) continue
        const fallback = typeof p?.default === 'string' ? p.default : '#ffffff'
        const v =
          typeof value === 'string' && key.toLowerCase().includes('color')
            ? normalizeColor(value, fallback)
            : value
        params[key] = { value: clampParam(v, p?.min, p?.max) }
      }
      clip = { ...base(), type: 'generator', generatorId: item.id, params }
    }
  } else if (s.type === 'solid') {
    clip = { ...base(), type: 'solid', color: { value: normalizeColor(s.color, '#101018') } }
  } else {
    return undefined
  }

  if (shot.opacity !== undefined) clip.opacity = { value: shot.opacity }
  if (shot.blendMode) clip.blendMode = shot.blendMode
  const adjustments = adjustmentsFrom(shot.adjustments)
  if (adjustments) clip.adjustments = adjustments
  clip.effects = effectsFor(shot.effects, ctx)
  const tIn = transition(shot.transitionIn, duration, ctx)
  if (tIn) clip.transitionIn = tIn
  const tOut = transition(shot.transitionOut, duration, ctx)
  if (tOut) clip.transitionOut = tOut
  applyMotion(clip, shot.motion)
  applyBindings(clip, shot.reactive, ctx)
  applyReactions(clip, shot.reactions, ctx)
  return clip
}

function setPath(target: object, path: PropertyPath, value: unknown) {
  let node = target as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (typeof next !== 'object' || next === null) return
    node = next as Record<string | number, unknown>
  }
  const last = path[path.length - 1]
  if (last !== undefined) node[last] = value
}

/** Music reactions, written exactly as the inspector's reaction picker writes them so it shows them by name. */
function applyReactions(clip: VisualClip, reactions: ReactionSpec[] | undefined, ctx: Ctx) {
  if (!reactions?.length) return
  const project: Project = { ...ctx.project, clips: { ...ctx.project.clips, [clip.id]: clip } }
  for (const r of reactions) {
    const target: ReactionTarget =
      'property' in r.target
        ? { clipId: clip.id, property: r.target.property }
        : { clipId: clip.id, param: r.target.param }
    for (const command of reactionCommands(project, [target], r.reaction, r.amount)) {
      if (command.type === 'clip.set') setPath(clip, command.path, command.value)
    }
  }
}

function textStyle(t: PlanText): TextStyle {
  const s = t.style
  return {
    ...DEFAULT_TEXT_STYLE,
    ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
    ...(s.fontSize ? { fontSize: s.fontSize } : {}),
    ...(s.fontWeight ? { fontWeight: s.fontWeight } : {}),
    ...(s.italic !== undefined ? { italic: s.italic } : {}),
    color: normalizeColor(s.color, DEFAULT_TEXT_STYLE.color),
    ...(s.align ? { align: s.align } : {}),
    ...(s.letterSpacing !== undefined ? { letterSpacing: s.letterSpacing } : {}),
    ...(s.maxWidth ? { maxWidth: s.maxWidth } : {}),
    ...(s.lineHeight ? { lineHeight: s.lineHeight } : {}),
    textTransform: s.textTransform ?? (s.uppercase ? 'uppercase' : 'none'),
    ...(s.stroke
      ? { stroke: { color: normalizeColor(s.stroke.color, '#000000'), width: s.stroke.width } }
      : {}),
    ...(s.shadow ? { shadow: { ...s.shadow, color: normalizeColor(s.shadow.color, '#000000b3') } } : {}),
    ...(s.background
      ? { background: { ...s.background, color: normalizeColor(s.background.color, '#000000b3') } }
      : {}),
  }
}

function textClip(t: PlanText, trackId: Id, ctx: Ctx): TextClip | undefined {
  const end = Math.min(t.end, ctx.plan.duration)
  const duration = end - t.start
  if (duration <= 0.01) return undefined
  const meta: DirectorClipMeta = {
    planId: ctx.plan.id,
    role: 'text',
    ...(t.sectionId ? { sectionId: t.sectionId } : {}),
    ...(t.role ? { textRole: t.role } : {}),
    ...(t.lyricLineId ? { lyricLineId: t.lyricLineId } : {}),
  }
  const clip: TextClip = {
    ...visualBase(trackId, t.start, duration, meta),
    type: 'text',
    text: t.text,
    style: textStyle(t),
  }
  const enter = t.enter
  const settle = (from: number | undefined, to: number): Animatable =>
    !enter || from === undefined || Math.abs(from - to) < 1e-6
      ? { value: to }
      : {
          value: from,
          keyframes: [
            { time: 0, value: from, easing: 'ease-out' },
            { time: round3(Math.min(enter.duration, duration / 2)), value: to, easing: 'linear' },
          ],
        }
  clip.transform.x = { value: t.position.x }
  clip.transform.y = settle(enter?.y, t.position.y)
  clip.transform.scaleX = settle(enter?.scale, t.scale ?? 1)
  clip.transform.scaleY = settle(enter?.scale, t.scale ?? 1)
  clip.opacity = settle(enter?.opacity, t.opacity ?? 1)
  // An emphasized word is timed by its own start; linked to the whole line, the renderer would look for its timing
  // among the line's first words only. A preview shows the line before it is sung, so it has no karaoke.
  const linked = t.role !== 'emphasis' && t.role !== 'preview'
  if (linked && t.lyricLineId && ctx.project.lyrics?.lines.some((l) => l.id === t.lyricLineId))
    clip.lyricLineId = t.lyricLineId
  if (t.behind && ctx.project.assets[t.behind.maskAssetId])
    clip.matte = behindSubjectMatte(t.behind.maskAssetId, t.behind.sourceAssetId)
  if (t.animationPresetId) {
    if (findItem(ctx.catalog.textPresets, t.animationPresetId))
      clip.animation = { presetId: t.animationPresetId, params: {} }
    else warn(ctx, `Text animation "${t.animationPresetId}" isn't available, so text appears without it.`)
  }
  if (t.karaoke && clip.lyricLineId) {
    clip.karaoke = {
      highlightColor: normalizeColor(t.karaoke.highlightColor, '#facc15'),
      mode: t.karaoke.mode,
    }
  }
  const tIn = transition(t.transitionIn, duration, ctx)
  if (tIn) clip.transitionIn = tIn
  const tOut = transition(t.transitionOut, duration, ctx)
  if (tOut) clip.transitionOut = tOut
  applyBindings(clip, t.reactive, ctx)
  return clip
}

function lookClip(look: PlanLook, trackId: Id, ctx: Ctx): VisualClip | undefined {
  const adjustments = adjustmentsFrom(look.adjustments)
  const effects = effectsFor(look.effects, ctx)
  if (!adjustments && effects.length === 0) return undefined
  const clip: VisualClip = {
    ...visualBase(trackId, 0, ctx.plan.duration, { planId: ctx.plan.id, role: 'look' }, look.name),
    type: 'adjustment',
  }
  if (adjustments) clip.adjustments = adjustments
  clip.effects = effects
  return clip
}

interface Cleanup {
  commands: EditCommand[]
  reused: Map<DirectorTrackRole, Id>
  removedTracks: Set<Id>
  removedClips: number
}

/** Removes earlier director clips, reusing tracks that held only one director role. Locked tracks are left alone. */
function cleanupPrevious(project: Project, ctx: Ctx): Cleanup {
  const commands: EditCommand[] = []
  const reused = new Map<DirectorTrackRole, Id>()
  const removedTracks = new Set<Id>()
  let removedClips = 0
  let keptLocked = false
  for (const track of project.tracks) {
    const clips = clipsOnTrack(project, track.id)
    const ours = clips.filter((c) => {
      const role = directorMeta(c)?.role
      return role !== undefined && role !== 'song'
    })
    if (ours.length === 0) continue
    if (track.locked) {
      keptLocked = true
      continue
    }
    const roles = new Set(ours.map((c) => directorMeta(c)?.role))
    const onlyOurs = ours.length === clips.length
    const role = roles.size === 1 ? ([...roles][0] as DirectorTrackRole) : undefined
    if (onlyOurs && role && track.kind === 'visual' && !reused.has(role)) {
      reused.set(role, track.id)
      commands.push({ type: 'clip.remove', clipIds: ours.map((c) => c.id) })
    } else if (onlyOurs) {
      removedTracks.add(track.id)
      commands.push({ type: 'track.remove', trackId: track.id })
    } else {
      commands.push({ type: 'clip.remove', clipIds: ours.map((c) => c.id) })
    }
    removedClips += ours.length
  }
  if (keptLocked)
    warn(ctx, 'Clips from an earlier draft on locked tracks were kept. Unlock those tracks to replace them.')
  return { commands, reused, removedTracks, removedClips }
}

function placeTracks(project: Project, needed: Set<DirectorTrackRole>, cleanup: Cleanup) {
  const commands: EditCommand[] = []
  const trackFor = new Map(cleanup.reused)
  const order = project.tracks.map((t) => t.id).filter((id) => !cleanup.removedTracks.has(id))
  let added = 0
  for (const [i, role] of TRACK_ORDER.entries()) {
    if (!needed.has(role) || trackFor.has(role)) continue
    const track: Track = createTrack('visual', TRACK_NAMES[role])
    const below = TRACK_ORDER.slice(i + 1)
      .map((r) => trackFor.get(r))
      .find((id) => id !== undefined)
    const above = TRACK_ORDER.slice(0, i)
      .reverse()
      .map((r) => trackFor.get(r))
      .find((id) => id !== undefined)
    const index = below ? order.indexOf(below) : above ? order.indexOf(above) + 1 : 0
    order.splice(index, 0, track.id)
    commands.push({ type: 'track.add', track, index })
    trackFor.set(role, track.id)
    added++
  }
  return { commands, trackFor, added }
}

/** Puts the song on the timeline when no clip plays it yet. */
function songCommands(project: Project, plan: EditPlan, removedTracks: Set<Id>): EditCommand[] {
  const songId = plan.songAssetId ?? project.songAssetId
  const song = songId ? project.assets[songId] : undefined
  if (!song || song.kind !== 'audio') return []
  const playing = Object.values(project.clips).some(
    (c) => c.type === 'audio' && c.assetId === song.id && !removedTracks.has(c.trackId),
  )
  if (playing) return []
  const commands: EditCommand[] = []
  let track = project.tracks.find((t) => t.kind === 'audio' && !t.locked && !removedTracks.has(t.id))
  if (!track) {
    track = createTrack('audio', 'Song')
    commands.push({ type: 'track.add', track })
  }
  const clip: AudioClip = {
    id: newId(),
    trackId: track.id,
    start: 0,
    duration: song.duration ?? plan.duration,
    enabled: true,
    type: 'audio',
    assetId: song.id,
    sourceStart: 0,
    playbackRate: 1,
    volume: { value: 1 },
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    meta: metaObject({ planId: plan.id, role: 'song' }),
  }
  commands.push({ type: 'clip.add', clip })
  return commands
}

export function compilePlan(plan: EditPlan, project: Project, options: CompileOptions = {}): CompiledPlan {
  const generated = options.generated ?? new Map<string, Asset>()
  const ctx: Ctx = {
    project,
    plan,
    catalog: options.catalog ?? DEFAULT_CATALOG,
    warnings: [],
    source: audioSourceMapper(project, plan.songAssetId ?? project.songAssetId),
  }
  const stats: CompileStats = { shots: 0, texts: 0, placeholders: 0, removedClips: 0, addedTracks: 0 }
  const cleanup: Cleanup =
    options.replacePrevious === false
      ? { commands: [], reused: new Map(), removedTracks: new Set(), removedClips: 0 }
      : cleanupPrevious(project, ctx)
  stats.removedClips = cleanup.removedClips

  const needed = new Set<DirectorTrackRole>()
  for (const s of plan.shots) needed.add(LAYER_ROLE[s.layer])
  if (plan.texts.length) needed.add('text')
  if (
    plan.look &&
    (adjustmentsFrom(plan.look.adjustments) ||
      plan.look.effects.some((e) => findItem(ctx.catalog.effects, e.effectId)))
  ) {
    needed.add('look')
  }
  for (const [role, trackId] of cleanup.reused) {
    if (needed.has(role)) continue
    cleanup.reused.delete(role)
    cleanup.removedTracks.add(trackId)
    cleanup.commands.push({ type: 'track.remove', trackId })
  }
  const placed = placeTracks(project, needed, cleanup)
  stats.addedTracks = placed.added

  const assetCommands: EditCommand[] = []
  const seenAssets = new Set<Id>()
  for (const asset of generated.values()) {
    if (project.assets[asset.id] || seenAssets.has(asset.id)) continue
    seenAssets.add(asset.id)
    assetCommands.push({ type: 'asset.add', asset })
  }

  const clips: Clip[] = []
  for (const shot of [...plan.shots].sort((a, b) => a.start - b.start)) {
    const trackId = placed.trackFor.get(LAYER_ROLE[shot.layer])
    if (!trackId) continue
    const clip = shotClip(shot, trackId, ctx, generated, stats)
    if (!clip) continue
    clips.push(clip)
    stats.shots++
  }
  const textTrack = placed.trackFor.get('text')
  for (const t of textTrack ? plan.texts : []) {
    const clip = textClip(t, textTrack as Id, ctx)
    if (!clip) continue
    clips.push(clip)
    stats.texts++
  }
  const lookTrack = placed.trackFor.get('look')
  if (plan.look && lookTrack) {
    const clip = lookClip(plan.look, lookTrack, ctx)
    if (clip) clips.push(clip)
  }
  if (stats.placeholders > 0) {
    warn(
      ctx,
      `${stats.placeholders} AI ${stats.placeholders === 1 ? 'shot is' : 'shots are'} not generated yet; dark placeholders mark where they go.`,
    )
  }

  return {
    commands: [
      ...cleanup.commands,
      ...placed.commands,
      ...assetCommands,
      ...songCommands(project, plan, cleanup.removedTracks),
      ...clips.map((clip): EditCommand => ({ type: 'clip.add', clip })),
    ],
    label: `Director: ${plan.title}`,
    warnings: ctx.warnings,
    stats,
  }
}
