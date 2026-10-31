/**
 * A compact, token-friendly description of a project for an LLM, with short ids (c1, t1, m1, s1, l1, k1) and a map
 * back to the real ids. Large projects keep the selected clips and those near the playhead; the rest are counted.
 */
import type { Clip, Id, Project, Seconds } from '../model/types.ts'
import { DEFAULT_CATALOG, type DirectorCatalog } from './catalog.ts'
import { directorMeta } from './meta.ts'

export interface IdMap {
  /** Short id → real id. */
  toReal: Map<string, Id>
  /** Real id → short id. */
  toShort: Map<Id, string>
}

export interface ProjectSummary {
  json: Record<string, unknown>
  ids: IdMap
  /** Clips left out of `json` because the project is large. */
  omittedClips: number
}

export interface SummaryOptions {
  selection?: Id[]
  /** A song section the user selected (on the Song map). */
  section?: Id
  playhead?: Seconds
  catalog?: DirectorCatalog
  /** Most clips to describe individually (default 200). */
  maxClips?: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

function createIdMap(): IdMap & { add(prefix: string, id: Id): string } {
  const toReal = new Map<string, Id>()
  const toShort = new Map<Id, string>()
  const counters = new Map<string, number>()
  return {
    toReal,
    toShort,
    add(prefix, id) {
      const existing = toShort.get(id)
      if (existing) return existing
      const n = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, n)
      const short = `${prefix}${n}`
      toReal.set(short, id)
      toShort.set(id, short)
      return short
    },
  }
}

function animatedValue(a: { value: unknown; keyframes?: unknown[]; modulation?: unknown[] } | undefined) {
  if (!a) return undefined
  const extra = [a.keyframes?.length ? 'animated' : '', a.modulation?.length ? 'music-reactive' : '']
    .filter(Boolean)
    .join(', ')
  const value = typeof a.value === 'number' ? r2(a.value) : a.value
  return extra ? `${String(value)} (${extra})` : value
}

function describeClip(clip: Clip, ids: ReturnType<typeof createIdMap>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ids.add('c', clip.id),
    track: ids.toShort.get(clip.trackId),
    type: clip.type,
    start: r2(clip.start),
    end: r2(clip.start + clip.duration),
  }
  if (clip.name) out.name = clip.name
  if (!clip.enabled) out.enabled = false
  const role = directorMeta(clip)?.role
  if (role) out.madeBy = `director ${role}`
  if ('assetId' in clip) {
    out.media = ids.toShort.get(clip.assetId)
    if (clip.type !== 'image' && clip.sourceStart) out.sourceStart = r2(clip.sourceStart)
    if (clip.type !== 'image' && clip.playbackRate !== 1) out.speed = clip.playbackRate
  }
  if (clip.type === 'audio' || clip.type === 'video') {
    if (clip.muted) out.muted = true
    if (clip.volume.value !== 1 || clip.volume.keyframes?.length) out.volume = animatedValue(clip.volume)
  }
  if (clip.type === 'audio') return out
  if (clip.type === 'text') {
    out.text = clip.text.length > 120 ? `${clip.text.slice(0, 119)}…` : clip.text
    out.fontSize = clip.style.fontSize
    out.color = clip.style.color
    if (clip.style.textTransform !== 'none') out.textTransform = clip.style.textTransform
    if (clip.animation) out.textAnimation = clip.animation.presetId
    if (clip.lyricLineId) out.lyricLine = ids.toShort.get(clip.lyricLineId)
  }
  if (clip.type === 'solid') out.color = animatedValue(clip.color)
  if (clip.type === 'generator') out.visualizer = clip.generatorId
  const t = clip.transform
  if (t.x.value !== 0.5 || t.x.keyframes?.length || t.x.modulation?.length) out.x = animatedValue(t.x)
  if (t.y.value !== 0.5 || t.y.keyframes?.length || t.y.modulation?.length) out.y = animatedValue(t.y)
  if (t.scaleX.value !== 1 || t.scaleX.keyframes?.length || t.scaleX.modulation?.length)
    out.scale = animatedValue(t.scaleX)
  if (t.rotation.value !== 0 || t.rotation.keyframes?.length) out.rotation = animatedValue(t.rotation)
  if (clip.opacity.value !== 1 || clip.opacity.keyframes?.length || clip.opacity.modulation?.length)
    out.opacity = animatedValue(clip.opacity)
  if (clip.blendMode !== 'normal') out.blendMode = clip.blendMode
  const adjustments = Object.entries(clip.adjustments ?? {}).filter(
    ([, a]) => a && (a.value !== 0 || a.modulation?.length),
  )
  if (adjustments.length)
    out.color_adjustments = Object.fromEntries(adjustments.map(([k, a]) => [k, animatedValue(a)]))
  if (clip.effects.length)
    out.effects = clip.effects.map((e) => (e.enabled ? e.effectId : `${e.effectId} (off)`))
  if (clip.transitionIn) out.transitionIn = `${clip.transitionIn.kind} ${r2(clip.transitionIn.duration)}s`
  if (clip.transitionOut) out.transitionOut = `${clip.transitionOut.kind} ${r2(clip.transitionOut.duration)}s`
  return out
}

function catalogSummary(catalog: DirectorCatalog) {
  const params = (item: DirectorCatalog['effects'][number]) =>
    (item.params ?? []).map((p) =>
      p.min !== undefined && p.max !== undefined ? `${p.key} ${p.min}..${p.max}` : `${p.key}`,
    )
  return {
    effects: catalog.effects.map((e) => ({ id: e.id, params: params(e) })),
    transitions: catalog.transitions.map((t) => t.id),
    visualizers: catalog.generators.map((g) => ({ id: g.id, params: params(g) })),
    textAnimations: catalog.textPresets.map((t) => t.id),
  }
}

export function summarizeProject(project: Project, options: SummaryOptions = {}): ProjectSummary {
  const ids = createIdMap()
  const tracks = project.tracks.map((t) => ({
    id: ids.add('t', t.id),
    name: t.name,
    kind: t.kind,
    ...(t.locked ? { locked: true } : {}),
    ...(t.hidden ? { hidden: true } : {}),
    ...(t.muted ? { muted: true } : {}),
  }))
  const media = Object.values(project.assets)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    .map((a) => ({
      id: ids.add('m', a.id),
      kind: a.kind,
      name: a.name,
      ...(a.duration ? { duration: r2(a.duration) } : {}),
      ...(a.id === project.songAssetId ? { mainSong: true } : {}),
    }))
  const analysis = project.songAssetId ? project.analysis.audio[project.songAssetId] : undefined
  const sections = (analysis?.sections ?? [])
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ id: ids.add('s', s.id), label: s.label, start: r2(s.start), end: r2(s.end) }))
  const lyrics = (project.lyrics?.lines ?? []).slice(0, 120).map((l) => ({
    id: ids.add('l', l.id),
    text: l.text.slice(0, 120),
    ...(l.start !== undefined ? { start: r2(l.start) } : {}),
  }))
  const markers = project.markers.map((m) => ({ id: ids.add('k', m.id), time: r2(m.time), label: m.label }))

  const selection = new Set(options.selection ?? [])
  const playhead = options.playhead ?? 0
  const max = options.maxClips ?? 200
  const all = Object.values(project.clips).sort((a, b) => a.start - b.start)
  let kept = all
  if (all.length > max) {
    const distance = (c: Clip) =>
      selection.has(c.id) ? -1 : Math.max(0, c.start - playhead, playhead - (c.start + c.duration))
    kept = [...all]
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, max)
      .sort((a, b) => a.start - b.start)
  }
  const clips = kept.map((c) => describeClip(c, ids))
  const json: Record<string, unknown> = {
    project: {
      name: project.name,
      aspect: project.settings.aspect,
      fps: project.settings.fps,
    },
    song: {
      ...(analysis?.tempo ? { bpm: Math.round(analysis.tempo.bpm) } : {}),
      ...(project.songAssetId && project.assets[project.songAssetId]?.duration
        ? { duration: r2(project.assets[project.songAssetId]!.duration!) }
        : {}),
      sections,
    },
    playhead: r2(playhead),
    selection: [...selection].map((id) => ids.toShort.get(id)).filter(Boolean),
    ...(options.section && ids.toShort.has(options.section)
      ? { selectedSection: ids.toShort.get(options.section) }
      : {}),
    tracks,
    clips,
    ...(all.length > kept.length ? { omittedClips: all.length - kept.length } : {}),
    media,
    ...(lyrics.length ? { lyrics } : {}),
    ...(markers.length ? { markers } : {}),
    catalog: catalogSummary(options.catalog ?? DEFAULT_CATALOG),
  }
  return { json, ids: { toReal: ids.toReal, toShort: ids.toShort }, omittedClips: all.length - kept.length }
}
