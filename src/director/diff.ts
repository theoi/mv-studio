/**
 * Dry-run previews of edit commands: applies them to a scratch editor and describes what would change in plain
 * language, so the director and plain-language commands can show "Show changes" before anything is applied.
 */
import { EditError, type EditCommand } from '../model/commands.ts'
import { ProjectEditor } from '../model/editor.ts'
import type { Clip, Id, Project, Seconds, Track } from '../model/types.ts'

export type ChangeTarget = 'clip' | 'track' | 'asset' | 'marker' | 'lyrics' | 'project' | 'analysis'

export interface ChangeItem {
  action: 'add' | 'remove' | 'change'
  target: ChangeTarget
  id?: Id
  /** One line naming the thing as it was before a change, e.g. 'Text “Hold on” at 0:42.1'. */
  label: string
  /** What changed, e.g. ['starts at 0:12.5 (was 0:10.0)'], or ['added'] / ['removed']. */
  details: string[]
  /** Timeline span to highlight. */
  range?: { start: Seconds; end: Seconds }
}

export type ChangePreview =
  | {
      ok: true
      /** The project as it would be after the commands. */
      project: Project
      items: ChangeItem[]
      /** e.g. "Adds 24 clips and 3 tracks, changes 2 clips." */
      summary: string
      counts: { added: number; removed: number; changed: number }
    }
  | { ok: false; error: EditError; message: string }

/** "1:05.2", "0:07.0". */
export function formatTime(t: Seconds): string {
  const total = Math.max(0, t)
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

const CLIP_KIND: Record<Clip['type'], string> = {
  video: 'Clip',
  image: 'Image',
  text: 'Text',
  solid: 'Color',
  generator: 'Visual',
  adjustment: 'Look layer',
  audio: 'Audio',
}

function clipName(clip: Clip, project: Project): string {
  if (clip.type === 'text') {
    const t = clip.text.replace(/\s+/g, ' ').trim()
    return `Text “${t.length > 32 ? `${t.slice(0, 31)}…` : t}”`
  }
  if (clip.name) return `${CLIP_KIND[clip.type]} “${clip.name}”`
  if ('assetId' in clip) {
    const asset = project.assets[clip.assetId]
    if (asset) return `${CLIP_KIND[clip.type]} “${asset.name}”`
  }
  if (clip.type === 'generator') return `Visual “${clip.generatorId}”`
  return CLIP_KIND[clip.type]
}

function clipLabel(clip: Clip, project: Project): string {
  return `${clipName(clip, project)} at ${formatTime(clip.start)}`
}

const FIELD_LABELS: Record<string, string> = {
  start: 'starts at',
  duration: 'length',
  trackId: 'track',
  enabled: 'enabled',
  text: 'text',
  'opacity.value': 'opacity',
  'transform.x.value': 'horizontal position',
  'transform.y.value': 'vertical position',
  'transform.scaleX.value': 'width scale',
  'transform.scaleY.value': 'height scale',
  'transform.rotation.value': 'rotation',
  blendMode: 'blend mode',
  'style.color': 'text color',
  'style.fontSize': 'text size',
  'style.fontFamily': 'font',
  'style.fontWeight': 'font weight',
  'style.textTransform': 'capitalization',
  'volume.value': 'volume',
  muted: 'muted',
  playbackRate: 'speed',
  sourceStart: 'source start',
  fit: 'fit',
  'color.value': 'color',
  generatorId: 'visual',
}

function short(value: unknown): string {
  if (value === undefined) return 'none'
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000)
  if (typeof value === 'string') return value.length > 40 ? `“${value.slice(0, 39)}…”` : `“${value}”`
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  const json = JSON.stringify(value)
  return json.length > 40 ? `${json.slice(0, 39)}…` : json
}

function leaves(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'keyframes' || k === 'modulation' || k === 'effects' || k === 'meta') continue
      leaves(v, prefix ? `${prefix}.${k}` : k, out)
    }
    return
  }
  out.set(prefix, value)
}

function animatedPaths(
  value: unknown,
  prefix: string,
  key: 'keyframes' | 'modulation',
  out: Map<string, string>,
) {
  if (typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    value.forEach((v, i) => animatedPaths(v, `${prefix}.${i}`, key, out))
    return
  }
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj[key])) out.set(prefix, JSON.stringify(obj[key]))
  for (const [k, v] of Object.entries(obj))
    if (k !== key && k !== 'meta') animatedPaths(v, prefix ? `${prefix}.${k}` : k, key, out)
}

function pathLabel(path: string): string {
  return (
    FIELD_LABELS[path] ??
    FIELD_LABELS[`${path}.value`] ??
    path
      .replace(/\.value$/, '')
      .replace(/^style\./, 'text ')
      .replace(/^adjustments\./, '')
      .replace(/\./g, ' ')
  )
}

function describeValue(path: string, value: unknown, tracks: Track[]): string {
  if ((path === 'start' || path === 'sourceStart') && typeof value === 'number') return formatTime(value)
  if (path === 'duration' && typeof value === 'number') return `${value.toFixed(1)} s`
  if (path === 'trackId' && typeof value === 'string')
    return `“${tracks.find((t) => t.id === value)?.name ?? 'track'}”`
  return short(value)
}

function clipDetails(before: Clip, after: Clip, beforeProject: Project, afterProject: Project): string[] {
  const details: string[] = []
  const a = new Map<string, unknown>()
  const b = new Map<string, unknown>()
  leaves(before, '', a)
  leaves(after, '', b)
  const tracks = [...afterProject.tracks, ...beforeProject.tracks]
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(path)
    const now = b.get(path)
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    if (path === 'name') continue
    // The item's label already names the old text.
    if (path === 'text' && before.type === 'text') {
      details.push(`now reads ${short(now)}`)
      continue
    }
    // A color adjustment created at neutral only to carry a music reaction is not a visible change by itself.
    if (was === undefined && now === 0 && path.startsWith('adjustments.')) continue
    details.push(
      `${pathLabel(path)} ${describeValue(path, now, tracks)} (was ${describeValue(path, was, tracks)})`,
    )
  }
  if ('effects' in before && 'effects' in after) {
    const was = new Map(before.effects.map((e) => [e.id, e]))
    const now = new Map(after.effects.map((e) => [e.id, e]))
    for (const [id, e] of now) {
      if (!was.has(id)) details.push(`effect ${e.effectId} added`)
      else if (JSON.stringify(was.get(id)) !== JSON.stringify(e)) details.push(`effect ${e.effectId} changed`)
    }
    for (const [id, e] of was) if (!now.has(id)) details.push(`effect ${e.effectId} removed`)
  }
  for (const key of ['keyframes', 'modulation'] as const) {
    const was = new Map<string, string>()
    const now = new Map<string, string>()
    animatedPaths(before, '', key, was)
    animatedPaths(after, '', key, now)
    for (const path of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(path) === now.get(path)) continue
      const what = key === 'keyframes' ? 'animation' : 'music reaction'
      const verb = !was.has(path) ? 'added to' : !now.has(path) ? 'removed from' : 'changed on'
      details.push(`${what} ${verb} ${pathLabel(path)}`)
    }
  }
  return details
}

function span(clip: Clip) {
  return { start: clip.start, end: clip.start + clip.duration }
}

/** Describes the difference between two projects. */
export function describeChanges(before: Project, after: Project): ChangeItem[] {
  const items: ChangeItem[] = []
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]))
  const afterTracks = new Map(after.tracks.map((t) => [t.id, t]))
  for (const t of after.tracks) {
    const old = beforeTracks.get(t.id)
    if (!old)
      items.push({ action: 'add', target: 'track', id: t.id, label: `Track “${t.name}”`, details: ['added'] })
    else {
      const details = (['name', 'muted', 'solo', 'locked', 'hidden'] as const)
        .filter((k) => old[k] !== t[k])
        .map((k) => `${k} ${short(t[k])} (was ${short(old[k])})`)
      if (details.length)
        items.push({ action: 'change', target: 'track', id: t.id, label: `Track “${t.name}”`, details })
    }
  }
  for (const t of before.tracks) {
    if (!afterTracks.has(t.id))
      items.push({
        action: 'remove',
        target: 'track',
        id: t.id,
        label: `Track “${t.name}”`,
        details: ['removed'],
      })
  }

  for (const asset of Object.values(after.assets)) {
    if (!before.assets[asset.id])
      items.push({
        action: 'add',
        target: 'asset',
        id: asset.id,
        label: `Media “${asset.name}”`,
        details: ['added'],
      })
    else if (before.assets[asset.id]?.name !== asset.name) {
      items.push({
        action: 'change',
        target: 'asset',
        id: asset.id,
        label: `Media “${asset.name}”`,
        details: [`renamed (was “${before.assets[asset.id]?.name}”)`],
      })
    }
  }
  for (const asset of Object.values(before.assets)) {
    if (!after.assets[asset.id])
      items.push({
        action: 'remove',
        target: 'asset',
        id: asset.id,
        label: `Media “${asset.name}”`,
        details: ['removed'],
      })
  }

  const clips = [...new Set([...Object.keys(before.clips), ...Object.keys(after.clips)])]
  const sorted = clips
    .map((id) => ({ id, before: before.clips[id], after: after.clips[id] }))
    .sort((x, y) => ((x.after ?? x.before)?.start ?? 0) - ((y.after ?? y.before)?.start ?? 0))
  for (const { id, before: was, after: now } of sorted) {
    if (now && !was)
      items.push({
        action: 'add',
        target: 'clip',
        id,
        label: clipLabel(now, after),
        details: ['added'],
        range: span(now),
      })
    else if (was && !now)
      items.push({
        action: 'remove',
        target: 'clip',
        id,
        label: clipLabel(was, before),
        details: ['removed'],
        range: span(was),
      })
    else if (was && now && was !== now && JSON.stringify(was) !== JSON.stringify(now)) {
      const details = clipDetails(was, now, before, after)
      const range = {
        start: Math.min(was.start, now.start),
        end: Math.max(was.start + was.duration, now.start + now.duration),
      }
      items.push({
        action: 'change',
        target: 'clip',
        id,
        label: clipLabel(was, before),
        details: details.length ? details : ['settings changed'],
        range,
      })
    }
  }

  const beforeMarkers = new Map(before.markers.map((m) => [m.id, m]))
  const afterMarkers = new Map(after.markers.map((m) => [m.id, m]))
  for (const m of after.markers) {
    const old = beforeMarkers.get(m.id)
    const label = `Marker “${m.label}” at ${formatTime(m.time)}`
    if (!old)
      items.push({
        action: 'add',
        target: 'marker',
        id: m.id,
        label,
        details: ['added'],
        range: { start: m.time, end: m.time + (m.duration ?? 0) },
      })
    else if (JSON.stringify(old) !== JSON.stringify(m))
      items.push({ action: 'change', target: 'marker', id: m.id, label, details: [] })
  }
  for (const m of before.markers) {
    if (!afterMarkers.has(m.id))
      items.push({
        action: 'remove',
        target: 'marker',
        id: m.id,
        label: `Marker “${m.label}”`,
        details: ['removed'],
      })
  }

  if (JSON.stringify(before.lyrics) !== JSON.stringify(after.lyrics)) {
    const was = before.lyrics?.lines.length ?? 0
    const now = after.lyrics?.lines.length ?? 0
    const action = !before.lyrics ? 'add' : !after.lyrics ? 'remove' : 'change'
    const details = {
      add: ['added'],
      remove: ['removed'],
      change: was !== now ? [`${now} lines (was ${was})`] : [],
    }
    items.push({ action, target: 'lyrics', label: 'Lyrics', details: details[action] })
  }
  if (JSON.stringify(before.analysis) !== JSON.stringify(after.analysis)) {
    items.push({ action: 'change', target: 'analysis', label: 'Song analysis', details: [] })
  }
  const projectDetails: string[] = []
  if (before.name !== after.name) projectDetails.push(`name “${after.name}” (was “${before.name}”)`)
  for (const key of Object.keys(after.settings) as (keyof Project['settings'])[]) {
    if (before.settings[key] !== after.settings[key])
      projectDetails.push(`${key} ${short(after.settings[key])} (was ${short(before.settings[key])})`)
  }
  if (before.songAssetId !== after.songAssetId) projectDetails.push('main song changed')
  if (before.duration !== after.duration)
    projectDetails.push(`length ${short(after.duration)} (was ${short(before.duration)})`)
  if (projectDetails.length)
    items.push({ action: 'change', target: 'project', label: 'Project', details: projectDetails })
  return items
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function summarizeChanges(items: ChangeItem[]): {
  summary: string
  counts: { added: number; removed: number; changed: number }
} {
  const count = (action: ChangeItem['action'], target: ChangeTarget) =>
    items.filter((i) => i.action === action && i.target === target).length
  const phrase = (action: ChangeItem['action']) => {
    const parts: string[] = []
    const clips = count(action, 'clip')
    const tracks = count(action, 'track')
    const assets = count(action, 'asset')
    const markers = count(action, 'marker')
    if (clips) parts.push(plural(clips, 'clip'))
    if (tracks) parts.push(plural(tracks, 'track'))
    if (assets) parts.push(plural(assets, 'media file'))
    if (markers) parts.push(plural(markers, 'marker'))
    if (count(action, 'lyrics')) parts.push('the lyrics')
    if (count(action, 'project')) parts.push('project settings')
    if (count(action, 'analysis')) parts.push('song analysis')
    return parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
      : (parts[0] ?? '')
  }
  const sentences = [
    ['Adds', phrase('add')],
    ['changes', phrase('change')],
    ['removes', phrase('remove')],
  ].filter(([, p]) => p)
  const counts = {
    added: items.filter((i) => i.action === 'add').length,
    removed: items.filter((i) => i.action === 'remove').length,
    changed: items.filter((i) => i.action === 'change').length,
  }
  if (sentences.length === 0) return { summary: 'No changes.', counts }
  const text = sentences
    .map(([verb, p], i) => `${i === 0 ? (verb as string).replace(/^./, (c) => c.toUpperCase()) : verb} ${p}`)
    .join(', ')
  return { summary: `${text}.`, counts }
}

/** Applies `commands` to a scratch copy and describes the result. Nothing changes in the real editor. */
export function previewCommands(project: Project, commands: EditCommand[]): ChangePreview {
  const scratch = new ProjectEditor(project)
  try {
    // The editor freezes objects it stores; clone so the caller's commands stay usable.
    scratch.dispatch(structuredClone(commands))
  } catch (error) {
    const err =
      error instanceof EditError
        ? error
        : new EditError('invalid', error instanceof Error ? error.message : String(error))
    return { ok: false, error: err, message: err.message }
  }
  const after = scratch.getProject()
  const items = describeChanges(project, after)
  const { summary, counts } = summarizeChanges(items)
  return { ok: true, project: after, items, summary, counts }
}
